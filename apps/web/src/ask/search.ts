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
  /** Product types to retrieve regardless of wording (S-E4 query expansion). */
  types?: readonly string[];
  /** Agency codes to retrieve regardless of wording. */
  rawCodes?: readonly string[];
}

export interface SearchHit {
  row: ObservationListRow;
  /** FTS5 rank, negated so larger is better. Zero for a category-only match. */
  lexicalScore: number;
  /** How this candidate got into the running — shown so retrieval explains itself. */
  via: "keyword" | "category";
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
  return terms.map((term) => (EXACT_TERMS.has(term) ? `"${term}"` : `"${term}"*`)).join(" OR ");
}

/**
 * Words whose prefix expansion means something else entirely.
 *
 * Prefix matching is what makes "gun" reach `PERSON W/GUN` and `GUNFIRE`, so it earns its
 * place — but `sex*` reaches `SEXUAL ASSAULT ADULT`, and answering a question about sex
 * work with a list of sexual assault calls is the worst failure this search can produce.
 * Measured on live data 2026-09-21: the top four hits for "sex work in the mission" were
 * all `SEXUAL ASSAULT ADULT`.
 */
export const EXACT_TERMS = new Set(["sex"]);

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
  const limit = options.limit ?? 30;
  const scope: string[] = [];
  const scopeParameters: (string | number)[] = [];
  if (options.neighborhood) {
    scope.push("o.neighborhood = ?");
    scopeParameters.push(options.neighborhood);
  }
  if (options.from) {
    scope.push("o.occurred_at >= ?");
    scopeParameters.push(options.from);
  }

  const hits = new Map<string, SearchHit>();

  // 1. Keywords, as typed.
  const match = toMatchQuery(text);
  if (match) {
    const clauses = ["observations_fts MATCH ?", ...scope];
    const rows = db
      .query<ObservationListRow & { rank: number }, (string | number)[]>(
        `SELECT ${COLUMNS}, rank
           FROM observations_fts
           JOIN observations o ON o.id = observations_fts.id
          WHERE ${clauses.join(" AND ")}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, ...scopeParameters, limit);

    for (const { rank, ...row } of rows) {
      hits.set(row.id, { row: row as ObservationListRow, lexicalScore: -rank, via: "keyword" });
    }
  }

  // 2. Types and agency codes the question was expanded to. This is the half that finds
  //    `SHOTS FIRED` when the reader typed "gunshots" — no shared word required.
  const categories: string[] = [];
  const categoryParameters: (string | number)[] = [];
  if (options.types && options.types.length > 0) {
    categories.push(`o.type IN (${options.types.map(() => "?").join(", ")})`);
    categoryParameters.push(...options.types);
  }
  if (options.rawCodes && options.rawCodes.length > 0) {
    categories.push(`o.raw_type IN (${options.rawCodes.map(() => "?").join(", ")})`);
    categoryParameters.push(...options.rawCodes);
  }

  if (categories.length > 0 && hits.size < limit) {
    const clauses = [`(${categories.join(" OR ")})`, ...scope];
    const rows = db
      .query<ObservationListRow, (string | number)[]>(
        `SELECT ${COLUMNS} FROM observations o
          WHERE ${clauses.join(" AND ")}
          ORDER BY o.occurred_at DESC
          LIMIT ?`,
      )
      .all(...categoryParameters, ...scopeParameters, limit - hits.size);

    for (const row of rows) {
      if (hits.has(row.id)) continue;
      // No FTS rank to inherit: a category match is a candidate the re-ranker orders, not
      // one that arrives pre-ranked.
      hits.set(row.id, { row, lexicalScore: 0, via: "category" });
    }
  }

  return [...hits.values()].slice(0, limit);
}
