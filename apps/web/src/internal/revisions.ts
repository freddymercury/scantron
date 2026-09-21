/**
 * What the agency changed when it republished a record (S-D7 prep).
 *
 * Every version of every payload is kept, which is what makes a correction traceable — but
 * a stack of near-identical JSON blobs is not readable. This turns two versions into the
 * handful of fields that actually differ.
 *
 * Volatile keys are excluded for the same reason `payloadHash` excludes them: `data_as_of`
 * and `data_loaded_at` change on every republication and mean nothing about the call. Once
 * they cost 34,000 jobs an hour and 2.5 million stored payloads; here they would just be
 * noise on every diff.
 */

export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "data_as_of",
  "data_loaded_at",
  // SFPD re-issues `id` on every republication, so it changes on every revision and says
  // nothing about the call. It is why `seriesKey` ignores it too.
  "id",
]);

export interface FieldChange {
  field: string;
  before: string | undefined;
  after: string | undefined;
  kind: "added" | "removed" | "changed";
}

function display(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** `(older, newer) → what changed`, ignoring the keys that change on every fetch. */
export function diffPayloads(
  older: Record<string, unknown>,
  newer: Record<string, unknown>,
): FieldChange[] {
  const fields = new Set([...Object.keys(older), ...Object.keys(newer)]);
  const changes: FieldChange[] = [];

  for (const field of [...fields].sort()) {
    if (VOLATILE_KEYS.has(field)) continue;
    const before = display(older[field]);
    const after = display(newer[field]);
    if (before === after) continue;
    changes.push({
      field,
      before,
      after,
      kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    });
  }
  return changes;
}

export interface Revision {
  at: string;
  changes: FieldChange[];
  /** Which row within the record this is a revision of, when the feed has several. */
  series?: string;
}

/**
 * The identity of a payload *within* a record.
 *
 * This is the trap this file exists to avoid. SFFD and SFEMS publish **one row per unit**,
 * and every row for a call is stored under the same `source_record_id` (the CAD number).
 * Diffing them in fetch order compares engine T05 against truck T03 and reports a dozen
 * fields "changed" when nothing did. Grouping by the feed's own row key first is what makes
 * a revision mean a revision.
 *
 * `id` is deliberately **not** one of the keys. SFPD's feed re-issues it on every
 * republication — five stored versions of one call carried five different `id`s — so
 * grouping on it would put every version in a series of its own and report that nothing
 * ever changes, on the one feed where things demonstrably do (call type changes on 3.3% of
 * calls). No row key means one series, which is the correct reading for that feed.
 */
export function seriesKey(payload: Record<string, unknown>): string {
  for (const field of ["rowid", "row_id"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

/**
 * Oldest-first payloads → one entry per republication that actually changed something.
 *
 * A republication with nothing but volatile keys moved produces no entry at all, which is
 * the common case and the one worth staying quiet about.
 */
export function revisions(payloads: readonly { fetched_at: string; payload: string }[]): Revision[] {
  const parsed = payloads
    .map((row) => ({ at: row.fetched_at, payload: JSON.parse(row.payload) as Record<string, unknown> }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const series = new Map<string, typeof parsed>();
  for (const entry of parsed) {
    const key = seriesKey(entry.payload);
    const bucket = series.get(key);
    if (bucket) bucket.push(entry);
    else series.set(key, [entry]);
  }

  const out: Revision[] = [];
  for (const [key, entries] of series) {
    for (let index = 1; index < entries.length; index += 1) {
      const changes = diffPayloads(entries[index - 1]!.payload, entries[index]!.payload);
      if (changes.length === 0) continue;
      const revision: Revision = { at: entries[index]!.at, changes };
      // Only worth naming when the record has more than one row in it.
      if (key && series.size > 1) revision.series = key;
      out.push(revision);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
