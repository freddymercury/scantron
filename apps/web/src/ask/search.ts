/**
 * Lexical retrieval over observations (S-E4), the first half of search.
 *
 * FTS5, built into SQLite: no index to run, no dependency to take. This half is fast,
 * deterministic and always available — the semantic re-rank in `jev.ts` is an optional
 * second pass that can be switched off without search stopping working.
 */

import type { Database } from "bun:sqlite";

import type { ObservationListRow } from "../internal/queries.ts";

export interface SearchOptions {
  neighborhood?: string | undefined;
  /** ISO-8601 lower bound on `occurred_at`. */
  from?: string | undefined;
  limit?: number;
}

export interface SearchHit {
  row: ObservationListRow;
  /** FTS5 rank, negated so larger is better. */
  lexicalScore: number;
}

/**
 * FTS5's query syntax is a language of its own, and a reader's question is not written in
 * it. Terms are quoted and OR-ed with prefix matching, which is the closest thing to "what
 * a search box does" without handing the reader a syntax error.
 */
export function toMatchQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

const STOPWORDS = new Set(
  "the and for with any all was were what whats show give near around about happening going this that there here".split(
    " ",
  ),
);

const COLUMNS =
  "o.id, o.source, o.source_record_id, o.occurred_at, o.ingested_at, o.type, o.type_confidence, o.raw_type, o.subtype, o.priority, o.priority_rank, o.location_raw, o.location_normalized, o.neighborhood, o.lat, o.lng, o.location_method, o.units, o.sensitive, o.backfilled";

export function searchObservations(
  db: Database,
  text: string,
  options: SearchOptions = {},
): SearchHit[] {
  const match = toMatchQuery(text);
  if (!match) return [];

  const clauses = ["observations_fts MATCH ?"];
  const parameters: (string | number)[] = [match];
  if (options.neighborhood) {
    clauses.push("o.neighborhood = ?");
    parameters.push(options.neighborhood);
  }
  if (options.from) {
    clauses.push("o.occurred_at >= ?");
    parameters.push(options.from);
  }
  parameters.push(options.limit ?? 30);

  return db
    .query<ObservationListRow & { rank: number }, (string | number)[]>(
      `SELECT ${COLUMNS}, rank
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(...parameters)
    .map(({ rank, ...row }) => ({ row: row as ObservationListRow, lexicalScore: -rank }));
}
