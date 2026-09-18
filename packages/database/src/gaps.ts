/**
 * Ingestion gaps (S-B5).
 *
 * A gap is an interval with no successful poll. That matters more here than it would
 * elsewhere: the real-time police feed keeps ~48 hours, so a gap that outlives the
 * retention window cannot be refilled from it at all — only from the historical dataset,
 * which lags ~1 day. Past both, the data is gone for good.
 */

import type { Database } from "bun:sqlite";

export type GapStatus = "open" | "filling" | "filled" | "unrecoverable";

export interface GapRow {
  id: string;
  source: string;
  gap_start: string;
  gap_end: string;
  detected_at: string;
  status: string;
  records_filled: number;
  attempts: number;
  last_attempt_at: string | null;
  filled_at: string | null;
  note: string | null;
}

/** Two missed polls is noise; this is the multiple at which silence becomes a gap. */
export const GAP_POLL_MULTIPLE = 3;
/** Older than this and the real-time feed can no longer help. Margin under the ~48 h. */
export const DEFAULT_RETENTION_HOURS = 40;
/** The historical dataset publishes ~1 day behind, so a fresh gap is not yet fillable. */
export const HISTORICAL_LAG_HOURS = 24;

export function recordGap(
  db: Database,
  input: { source: string; from: Date; to: Date; note?: string },
  now: Date = new Date(),
): GapRow | undefined {
  // The id includes the end as well as the start: re-detecting the same silence a minute
  // later is the *same* start with a *later* end, which collided on the primary key while
  // satisfying the (source, start, end) unique constraint — and an unhandled constraint
  // error at startup killed the ingest process outright.
  const id = `gap_${input.source}_${input.from.getTime()}_${input.to.getTime()}`;
  db.query(
    `INSERT INTO ingestion_gaps (id, source, gap_start, gap_end, detected_at, status, note)
     VALUES (?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT DO NOTHING`,
  ).run(
    id,
    input.source,
    input.from.toISOString(),
    input.to.toISOString(),
    now.toISOString(),
    input.note ?? null,
  );
  return db.query<GapRow, [string]>("SELECT * FROM ingestion_gaps WHERE id = ?").get(id) ?? undefined;
}

/**
 * Compare the last successful poll against the clock and record a gap if the silence is
 * longer than a few intervals. Called on every poll *and* on startup, because the gap that
 * matters most is the one a crash or a long deploy left behind.
 */
export function detectGap(
  db: Database,
  source: string,
  now: Date = new Date(),
  options: { pollMultiple?: number } = {},
): GapRow | undefined {
  const row = db
    .query<{ last_success_at: string | null; poll_seconds: number }, [string]>(
      "SELECT last_success_at, poll_seconds FROM source_configuration WHERE source = ?",
    )
    .get(source);
  if (!row?.last_success_at) return undefined;

  const lastSuccess = new Date(row.last_success_at);
  const toleranceMs = row.poll_seconds * (options.pollMultiple ?? GAP_POLL_MULTIPLE) * 1000;
  if (now.getTime() - lastSuccess.getTime() <= toleranceMs) return undefined;

  // One open gap per silence: re-detecting it every cycle would otherwise pile up a row a
  // minute for as long as the source stays down.
  const existing = db
    .query<GapRow, [string, string]>(
      `SELECT * FROM ingestion_gaps
        WHERE source = ? AND gap_start = ? AND status IN ('open', 'filling')
        ORDER BY gap_end DESC LIMIT 1`,
    )
    .get(source, lastSuccess.toISOString());
  if (existing) return existing;

  return recordGap(
    db,
    { source, from: lastSuccess, to: now, note: `no successful poll for ${Math.round((now.getTime() - lastSuccess.getTime()) / 1000)}s` },
    now,
  );
}

export interface GapClassification {
  gap: GapRow;
  /** The real-time feed can still serve this window. */
  liveFillable: boolean;
  /** The historical dataset should have these rows by now. */
  historicallyFillable: boolean;
  /** Neither can help: this is permanent loss, and a different alert from "feed slow". */
  unrecoverable: boolean;
}

export function classifyGap(
  gap: GapRow,
  now: Date = new Date(),
  options: { retentionHours?: number; historicalLagHours?: number } = {},
): GapClassification {
  const retentionMs = (options.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3600 * 1000;
  const historicalLagMs = (options.historicalLagHours ?? HISTORICAL_LAG_HOURS) * 3600 * 1000;
  const ageMs = now.getTime() - new Date(gap.gap_start).getTime();
  const endAgeMs = now.getTime() - new Date(gap.gap_end).getTime();

  const liveFillable = ageMs <= retentionMs;
  // Rows younger than the historical dataset's own lag simply have not been published yet;
  // that is a "try again later", not a failure.
  const historicallyFillable = endAgeMs >= historicalLagMs;
  return {
    gap,
    liveFillable,
    historicallyFillable,
    unrecoverable: !liveFillable && !historicallyFillable && ageMs > retentionMs + historicalLagMs,
  };
}

export function openGaps(db: Database, source?: string): GapRow[] {
  const where = source ? "WHERE status IN ('open', 'filling') AND source = ?" : "WHERE status IN ('open', 'filling')";
  const parameters = source ? [source] : [];
  return db
    .query<GapRow, string[]>(`SELECT * FROM ingestion_gaps ${where} ORDER BY gap_start`)
    .all(...parameters);
}

export function updateGap(
  db: Database,
  id: string,
  patch: { status?: GapStatus; recordsFilled?: number; note?: string },
  now: Date = new Date(),
): void {
  const assignments: string[] = ["attempts = attempts + 1", "last_attempt_at = ?"];
  const parameters: (string | number | null)[] = [now.toISOString()];

  if (patch.status) {
    assignments.push("status = ?");
    parameters.push(patch.status);
    if (patch.status === "filled") {
      assignments.push("filled_at = ?");
      parameters.push(now.toISOString());
    }
  }
  if (patch.recordsFilled !== undefined) {
    assignments.push("records_filled = records_filled + ?");
    parameters.push(patch.recordsFilled);
  }
  if (patch.note !== undefined) {
    assignments.push("note = ?");
    parameters.push(patch.note);
  }
  parameters.push(id);
  db.query(`UPDATE ingestion_gaps SET ${assignments.join(", ")} WHERE id = ?`).run(...parameters);
}

export interface QuarantineInput {
  source: string;
  reason: string;
  payload: unknown;
}

/** Rejected rows are kept, with the reason. Nothing is dropped silently. */
export function quarantineRecord(
  db: Database,
  input: QuarantineInput,
  now: Date = new Date(),
): void {
  const serialized = JSON.stringify(input.payload);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serialized);
  const hash = hasher.digest("hex");

  db.query(
    `INSERT INTO quarantined_records (id, source, reason, payload, payload_hash, quarantined_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, payload_hash) DO NOTHING`,
  ).run(`qr_${input.source}_${hash.slice(0, 16)}`, input.source, input.reason, serialized, hash, now.toISOString());
}

export function quarantinedRecords(db: Database, source?: string, limit = 100) {
  const where = source ? "WHERE source = ?" : "";
  const parameters = source ? [source, limit] : [limit];
  return db
    .query<
      { id: string; source: string; reason: string; payload: string; quarantined_at: string },
      (string | number)[]
    >(`SELECT * FROM quarantined_records ${where} ORDER BY quarantined_at DESC LIMIT ?`)
    .all(...parameters);
}
