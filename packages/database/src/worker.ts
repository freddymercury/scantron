/**
 * The worker loop around the queue (S-A5): claim, run, complete or fail, repeat.
 *
 * Shutdown is the interesting part. `stop()` stops claiming immediately, waits for the
 * jobs already in flight, and resolves only once the queue has let go — so a deploy never
 * leaves a job marked `running` with nobody running it.
 */

import type { Database } from "bun:sqlite";
import { claim, complete, fail, type Job, type JobType, type RetryPolicy } from "./queue.ts";

export type JobHandler<P = unknown> = (job: Job<P>) => void | Promise<void>;

export interface WorkerEvent {
  event: "claimed" | "completed" | "failed" | "retrying" | "unhandled";
  job: Job;
  error?: unknown;
  durationMs?: number;
}

export interface WorkerOptions {
  db: Database;
  /** Identifies this worker in `locked_by`. */
  name: string;
  handlers: Partial<Record<JobType, JobHandler<never>>>;
  /** How long to sleep when there was nothing to do. */
  idleMs?: number;
  batchSize?: number;
  retry?: RetryPolicy;
  onEvent?: (event: WorkerEvent) => void;
}

export interface Worker {
  /** Runs until `stop()`. Resolves when the loop has fully drained. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One claim-and-run pass. Returns how many jobs ran. Useful in tests. */
  tick(): Promise<number>;
  readonly running: boolean;
}

export function createWorker(options: WorkerOptions): Worker {
  const { db, name, handlers } = options;
  const idleMs = options.idleMs ?? 250;
  const batchSize = options.batchSize ?? 1;
  const emit = options.onEvent ?? (() => {});

  let accepting = false;
  let loop: Promise<void> | undefined;
  let inFlight = 0;

  async function runJob(job: Job): Promise<void> {
    const handler = handlers[job.type] as JobHandler<unknown> | undefined;
    const startedAt = Date.now();
    inFlight += 1;
    try {
      if (!handler) {
        // An unregistered type is a failure, not a silent drop: it retries, then parks
        // as `failed` where the internal viewer can see it.
        throw new Error(`no handler registered for job type "${job.type}"`);
      }
      await handler(job);
      complete(db, job.id);
      emit({ event: "completed", job, durationMs: Date.now() - startedAt });
    } catch (error) {
      const outcome = fail(db, job, error, options.retry ? { policy: options.retry } : {});
      emit({
        event: outcome.status === "failed" ? "failed" : "retrying",
        job,
        error,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      inFlight -= 1;
    }
  }

  async function tick(): Promise<number> {
    const jobs = claim(db, { worker: name, limit: batchSize });
    for (const job of jobs) {
      emit({ event: "claimed", job });
      await runJob(job);
    }
    return jobs.length;
  }

  return {
    get running() {
      return accepting;
    },
    async start(): Promise<void> {
      if (accepting) return loop;
      accepting = true;
      loop = (async () => {
        while (accepting) {
          const ran = await tick();
          if (ran === 0 && accepting) await Bun.sleep(idleMs);
        }
        // Nothing new is claimed once `accepting` is false; wait out what is running.
        while (inFlight > 0) await Bun.sleep(5);
      })();
      return loop;
    },
    async stop(): Promise<void> {
      accepting = false;
      await loop;
      loop = undefined;
    },
    tick,
  };
}
