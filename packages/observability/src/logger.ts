/**
 * Structured logging (S-A6, PRD §40). JSON to stdout, one object per line — no transport,
 * no library, no buffering to lose on crash.
 *
 * The redaction rule is the part that matters: a log line must never carry source
 * free-text or address detail below block level (S-E1). `LOG_FIELDS` is therefore an
 * allowlist — a field nobody named cannot be logged by accident, exactly as
 * @scantron/incident-schema treats public payloads.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** PRD §40's minimum fields, plus the few we found we could not debug without. */
export const LOG_FIELDS = [
  "request_id",
  "observation_id",
  "incident_id",
  "source",
  "processor",
  "processing_time_ms",
  "result",
  "error",
  "job_id",
  "job_type",
  "attempt",
  "count",
  "status",
  "dataset_id",
  "neighborhood",
  "duration_ms",
  "lag_seconds",
] as const;
export type LogField = (typeof LOG_FIELDS)[number];

export type LogFields = Partial<Record<LogField, unknown>>;

export interface LogLine extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
  /** How many fields the allowlist dropped; never which, and never their values. */
  dropped_fields?: number;
}

export interface LoggerOptions {
  /** Defaults to `LOG_LEVEL`, then `info`. */
  level?: LogLevel;
  /** Fields carried on every line from this logger — `processor`, `request_id`, and so on. */
  context?: LogFields;
  /** Where lines go. Overridden in tests; stdout otherwise. */
  sink?: (line: LogLine) => void;
  now?: () => Date;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A child logger carrying extra context — how `request_id` propagates. */
  child(context: LogFields): Logger;
  readonly context: LogFields;
}

const ALLOWED = new Set<string>(LOG_FIELDS);

/** Drops any field not on the allowlist. Returns the kept fields and the dropped names. */
export function redact(fields: LogFields): { kept: LogFields; dropped: string[] } {
  const kept: LogFields = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED.has(key)) kept[key as LogField] = value;
    else dropped.push(key);
  }
  return { kept, dropped };
}

function defaultLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.trim() as LogLevel | undefined;
  return configured && LOG_LEVELS.includes(configured) ? configured : "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const context = options.context ?? {};
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? ((line: LogLine) => console.log(JSON.stringify(line)));

  function write(lineLevel: LogLevel, event: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return;
    const { kept, dropped } = redact({ ...context, ...fields });
    const line: LogLine = { ts: now().toISOString(), level: lineLevel, event, ...kept };
    // Say that something was dropped, never what it was.
    if (dropped.length > 0) line.dropped_fields = dropped.length;
    sink(line);
  }

  return {
    context,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (extra) =>
      createLogger({
        ...options,
        level,
        context: { ...context, ...extra },
      }),
  };
}

/** A trace id, generated once at ingest and carried by every job it spawns. */
export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

/** Normalizes a thrown value into the `error` field without leaking a stack into logs. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
