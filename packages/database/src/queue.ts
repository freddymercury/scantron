/**
 * The job queue (S-A5). Small, durable, and in the database, so a restart loses nothing.
 *
 * Postgres would claim with `FOR UPDATE SKIP LOCKED`; SQLite's equivalent is a
 * `BEGIN IMMEDIATE` transaction that selects and marks in one atomic step. The write lock
 * is exclusive, so two workers cannot claim the same row — the concurrency test asserts
 * exactly that against two connections to the same file.
 */

import type { Database } from "bun:sqlite";

export const JOB_TYPES = [
  "normalize_observation",
  "geocode_location",
  "correlate_incident",
  "publish_incident",
  "summarize_incident",
  /** Refill a detected ingestion gap from the historical dataset (S-B5). */
  "backfill_gap",
  /** Registered, unimplemented until Phase 2 (S-G*). */
  "transcribe_audio",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  run_after: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Job<P = unknown> {
  id: string;
  type: JobType;
  payload: P;
  status: JobStatus;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  lockedBy?: string;
  lastError?: string;
  dedupeKey?: string;
}

export interface EnqueueOptions<P = unknown> {
  type: JobType;
  payload: P;
  /** Earliest time this job may run. Defaults to now. */
  runAfter?: Date;
  maxAttempts?: number;
  /** Uniqueness for *pending* work, e.g. `normalize_observation:obs_1`. */
  dedupeKey?: string;
}

export interface RetryPolicy {
  /** First retry delay; doubles per attempt. */
  baseSeconds: number;
  maxSeconds: number;
  /** Fraction of the delay applied as random jitter, to avoid a retry thundering herd. */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseSeconds: 5, maxSeconds: 900, jitter: 0.2 };

function toJob(row: JobRow): Job {
  const job: Job = {
    id: row.id,
    type: row.type as JobType,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status as JobStatus,
    runAfter: new Date(row.run_after),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
  if (row.locked_by !== null) job.lockedBy = row.locked_by;
  if (row.last_error !== null) job.lastError = row.last_error;
  if (row.dedupe_key !== null) job.dedupeKey = row.dedupe_key;
  return job;
}

const iso = (date: Date): string => date.toISOString();

/**
 * Enqueue, unless an identical `dedupeKey` is already waiting — in which case this is a
 * no-op returning the existing job, because scheduling the same work twice is a bug the
 * queue should absorb rather than a state the caller must check for.
 */
export function enqueue<P>(
  db: Database,
  options: EnqueueOptions<P>,
  now: Date = new Date(),
): { job: Job<P>; created: boolean } {
  const id = `job_${crypto.randomUUID()}`;
  const runAfter = options.runAfter ?? now;

  if (options.dedupeKey) {
    const existing = db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE dedupe_key = ?")
      .get(options.dedupeKey);
    if (existing) return { job: toJob(existing) as Job<P>, created: false };
  }

  db.query(
    `INSERT INTO jobs (id, type, payload, status, run_after, attempts, max_attempts,
                       dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    options.type,
    JSON.stringify(options.payload),
    iso(runAfter),
    options.maxAttempts ?? 5,
    options.dedupeKey ?? null,
    iso(now),
    iso(now),
  );

  const row = db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow;
  return { job: toJob(row) as Job<P>, created: true };
}

export interface ClaimOptions {
  /** Identifies the worker holding the lock; shows up in the internal viewer. */
  worker: string;
  limit?: number;
  types?: readonly JobType[];
}

/** Atomically claim due jobs. Never returns a job another worker holds. */
export function claim(db: Database, options: ClaimOptions, now: Date = new Date()): Job[] {
  const limit = options.limit ?? 1;
  const typeFilter = options.types?.length
    ? ` AND type IN (${options.types.map(() => "?").join(", ")})`
    : "";
  const parameters = [iso(now), ...(options.types ?? []), limit];

  // BEGIN IMMEDIATE: the select and the update are one exclusive write transaction, which
  // is what makes the claim atomic across processes.
  const run = db.transaction((): JobRow[] => {
    const due = db
      .query<JobRow, (string | number)[]>(
        `SELECT * FROM jobs
          WHERE status = 'pending' AND run_after <= ?${typeFilter}
          ORDER BY run_after, id
          LIMIT ?`,
      )
      .all(...parameters);

    if (due.length === 0) return [];

    const update = db.query(
      `UPDATE jobs
          SET status = 'running', locked_by = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    const claimed: JobRow[] = [];
    for (const row of due) {
      const result = update.run(options.worker, iso(now), iso(now), row.id);
      if (result.changes === 1) {
        claimed.push({ ...row, status: "running", attempts: row.attempts + 1, locked_by: options.worker });
      }
    }
    return claimed;
  });

  return run.immediate().map(toJob);
}

export function complete(db: Database, jobId: string, now: Date = new Date()): void {
  db.query(
    `UPDATE jobs
        SET status = 'completed', completed_at = ?, updated_at = ?, locked_by = NULL,
            locked_at = NULL, last_error = NULL, dedupe_key = NULL
      WHERE id = ?`,
  ).run(iso(now), iso(now), jobId);
}

export function retryDelaySeconds(
  attempts: number,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseSeconds * 2 ** Math.max(0, attempts - 1), policy.maxSeconds);
  const jitter = exponential * policy.jitter * (random() * 2 - 1);
  // Clamp after jitter, so `maxSeconds` is a real ceiling rather than an approximate one.
  return Math.min(policy.maxSeconds, Math.max(0, exponential + jitter));
}

/**
 * Record a failure: retried with exponential backoff and jitter until `max_attempts`, then
 * parked as `failed`. Nothing is ever silently dropped — a failed job stays queryable.
 */
export function fail(
  db: Database,
  job: Pick<Job, "id" | "attempts" | "maxAttempts">,
  error: unknown,
  options: { now?: Date; policy?: RetryPolicy; random?: () => number } = {},
): { status: JobStatus; runAfter: Date } {
  const now = options.now ?? new Date();
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  if (exhausted) {
    db.query(
      `UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ?, locked_by = NULL,
              locked_at = NULL
        WHERE id = ?`,
    ).run(message, iso(now), job.id);
    return { status: "failed", runAfter: now };
  }

  const delay = retryDelaySeconds(job.attempts, options.policy ?? DEFAULT_RETRY, options.random);
  const runAfter = new Date(now.getTime() + delay * 1000);
  db.query(
    `UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, updated_at = ?,
            locked_by = NULL, locked_at = NULL
      WHERE id = ?`,
  ).run(iso(runAfter), message, iso(now), job.id);
  return { status: "pending", runAfter };
}

/** Graceful shutdown: hand an unfinished job back without burning an attempt. */
export function release(db: Database, jobId: string, now: Date = new Date()): void {
  db.query(
    `UPDATE jobs
        SET status = 'pending', locked_by = NULL, locked_at = NULL,
            attempts = MAX(attempts - 1, 0), updated_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(iso(now), jobId);
}

/**
 * Jobs whose worker died holding the lock. Reclaimed by age rather than by heartbeat:
 * simpler, and a stuck job that runs twice is safe because handlers are idempotent.
 */
export function reclaimStale(db: Database, olderThanSeconds: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanSeconds * 1000);
  const result = db
    .query(
      `UPDATE jobs SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ?
        WHERE status = 'running' AND locked_at < ?`,
    )
    .run(iso(now), iso(cutoff));
  return result.changes;
}

/**
 * Completed jobs are history, not work, and nothing was deleting them: three days of
 * running left 5.1 million rows in a 5.6 GB database. They are kept long enough to debug a
 * recent incident and no longer.
 */
export const DEFAULT_COMPLETED_RETENTION_HOURS = 6;

export function pruneCompletedJobs(
  db: Database,
  retentionHours = DEFAULT_COMPLETED_RETENTION_HOURS,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now.getTime() - retentionHours * 3600 * 1000).toISOString();
  // Failed jobs are never pruned: they are the ones somebody still has to look at.
  return db
    .query("DELETE FROM jobs WHERE status = 'completed' AND completed_at < ?")
    .run(cutoff).changes;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  /** Age in seconds of the oldest claimable job; the number that says "we are behind". */
  oldestPendingAgeSeconds: number;
}

export function queueStats(db: Database, now: Date = new Date()): QueueStats {
  const counts = db
    .query<{ status: string; n: number }, []>("SELECT status, count(*) AS n FROM jobs GROUP BY status")
    .all();
  const stats: QueueStats = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    oldestPendingAgeSeconds: 0,
  };
  for (const { status, n } of counts) {
    if (status in stats) stats[status as keyof Omit<QueueStats, "oldestPendingAgeSeconds">] = n;
  }

  const oldest = db
    .query<{ run_after: string }, [string]>(
      "SELECT run_after FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after LIMIT 1",
    )
    .get(iso(now));
  if (oldest) {
    stats.oldestPendingAgeSeconds = Math.max(
      0,
      (now.getTime() - new Date(oldest.run_after).getTime()) / 1000,
    );
  }
  return stats;
}

export function getJob(db: Database, jobId: string): Job | undefined {
  const row = db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(jobId);
  return row ? toJob(row) : undefined;
}

export function listJobs(
  db: Database,
  filter: { status?: JobStatus; type?: JobType; limit?: number } = {},
): Job[] {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (filter.status) {
    clauses.push("status = ?");
    parameters.push(filter.status);
  }
  if (filter.type) {
    clauses.push("type = ?");
    parameters.push(filter.type);
  }
  parameters.push(filter.limit ?? 100);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .query<JobRow, (string | number)[]>(`SELECT * FROM jobs ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...parameters)
    .map(toJob);
}
