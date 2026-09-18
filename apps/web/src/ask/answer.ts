/**
 * Running a parsed question and rendering the answer (S-H4).
 *
 * Every sentence here comes from a template over structured fields. Nothing is generated
 * prose, and nothing claims more than dispatch data supports — "what was reported and who
 * responded", never what happened to anyone (PRD §21, §30).
 */

import type { Database } from "bun:sqlite";

import { INCIDENT_TYPES } from "@scantron/incident-schema";

import type { ObservationListRow } from "../internal/queries.ts";
import { expandQuery } from "./expand.ts";
import { createJevClient, type JevClient } from "./jev.ts";
import type { AskQuery } from "./parse.ts";
import { planRetrieval, rerank, type RerankResult } from "./rerank.ts";
import { searchObservations } from "./search.ts";

export interface RankedObservation {
  row: ObservationListRow;
  score: number;
  /** Why this one surfaced, in the words shown to the reader. */
  reasons: string[];
}

export interface RetrievalExpansion {
  types: string[];
  rawCodes: string[];
  /** Reader-facing words for what the question was expanded to. */
  matched: string[];
}

/**
 * What the question expands to, before anything is retrieved: our own vocabulary first
 * (category phrases, colloquial forms, the agency's own labels), then — if Jev is
 * available — its judgement of which kinds of call the question is about.
 */
export async function expandForRetrieval(
  db: Database,
  query: AskQuery,
  client: JevClient,
): Promise<RetrievalExpansion> {
  const expansion = expandQuery(db, query.question);
  const plan = await planRetrieval(client, query.question, INCIDENT_TYPES);
  return {
    types: [...new Set([...expansion.types, ...plan.types])],
    rawCodes: expansion.rawCodes,
    matched: [...expansion.matched, ...(plan.reason === undefined ? [] : [plan.reason])],
  };
}

export interface AskAnswer {
  query: AskQuery;
  total: number;
  rows: ObservationListRow[];
  ranked: RankedObservation[];
  /** Counts by type for the window, for the "what's happening" shape of question. */
  breakdown: { type: string; n: number }[];
  /** Records in the window whose location the source withheld. */
  withheldLocations: number;
  /** Full-window comparison for context: same window length, immediately before. */
  previousTotal: number;
  /** Present when the question fell through the grammar and was answered by search. */
  search?: RerankResult;
}

/**
 * The grammar answers structure — a category, an area, a window. Words it could not place
 * are a *search*, not a failure: "something about a car being broken into on Valencia" has
 * no category in our taxonomy but is perfectly findable.
 */
export async function runSearchFallback(
  db: Database,
  query: AskQuery,
  now: Date = new Date(),
  client: JevClient = createJevClient(),
): Promise<RerankResult> {
  const text = query.unresolved.join(" ");

  // Retrieval is two steps before ranking is one. First the question is expanded through
  // vocabulary we own — category phrases, colloquial forms, the agency's own labels — so
  // that "gunshots" reaches SHOTS FIRED without sharing a word with it.
  const expansion = expandQuery(db, query.question);

  // Then, if Jev is available, it judges which kinds of call the question is about. That
  // is what gives recall a keyword index cannot: the judgement is about the sentence, and
  // costs one small request with no candidates in it.
  const plan = await planRetrieval(client, query.question, INCIDENT_TYPES);
  const types = [...new Set([...expansion.types, ...plan.types])];

  const scope = {
    ...(query.area === undefined ? {} : { neighborhood: query.area }),
    ...(query.windowMinutes > 0
      ? { from: new Date(now.getTime() - query.windowMinutes * 60_000).toISOString() }
      : {}),
  };
  const hits = searchObservations(db, text, {
    ...scope,
    types,
    rawCodes: expansion.rawCodes,
    limit: 30,
  });

  const result = await rerank(client, query.question, hits);
  result.expandedTo = [
    ...expansion.matched,
    ...(plan.reason === undefined ? [] : [plan.reason]),
  ];
  result.retrievedByCategory = hits.filter((hit) => hit.via === "category").length;
  return result;
}

function conditions(query: AskQuery, now: Date): { sql: string; parameters: (string | number)[] } {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];

  if (query.windowMinutes > 0) {
    clauses.push("occurred_at >= ?");
    parameters.push(new Date(now.getTime() - query.windowMinutes * 60_000).toISOString());
  }
  if (query.area) {
    clauses.push("neighborhood = ?");
    parameters.push(query.area);
  }
  // Codes and types are an OR: "car break-ins" is best expressed as the agency's own code,
  // but a fire-side record for the same thing only has a type.
  const typeClauses: string[] = [];
  if (query.rawCodes.length > 0) {
    typeClauses.push(`raw_type IN (${query.rawCodes.map(() => "?").join(", ")})`);
    parameters.push(...query.rawCodes);
  }
  if (query.types.length > 0 && query.rawCodes.length === 0) {
    typeClauses.push(`type IN (${query.types.map(() => "?").join(", ")})`);
    parameters.push(...query.types);
  }
  if (typeClauses.length > 0) clauses.push(`(${typeClauses.join(" OR ")})`);

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
}

const TYPE_WEIGHT: Readonly<Record<string, number>> = {
  weapon: 5,
  robbery: 4,
  fire: 4,
  assault: 4,
  rescue: 3,
  collision: 3,
  burglary: 2,
  hazard: 2,
  missing_person: 3,
  medical: 1,
  theft: 1,
  disturbance: 1,
  traffic: 0,
  police_activity: 0,
  public_safety: 1,
  unknown: 0,
};

/**
 * "Most interesting" is a ranking we have to be able to defend, so every point it awards
 * is something a reader can check: what the agency called it, how urgently it was
 * dispatched, how many units went, and whether a second agency turned up too.
 */
export function rank(db: Database, rows: ObservationListRow[], limit = 3): RankedObservation[] {
  const ranked = rows.map((row) => {
    const reasons: string[] = [];
    let score = 0;

    const weight = TYPE_WEIGHT[row.type ?? "unknown"] ?? 0;
    score += weight;

    if (row.priority_rank !== null && row.priority_rank <= 2) {
      score += 3 - row.priority_rank;
      reasons.push(`dispatched at priority ${row.priority_rank} of 5`);
    }

    const units = row.units ? (JSON.parse(row.units) as string[]) : [];
    if (units.length >= 3) {
      score += 2;
      reasons.push(`${units.length} units responded`);
    } else if (units.length > 0) {
      reasons.push(`${units.join(", ")} responded`);
    }

    // A second agency at the same place and time is the strongest signal in this data that
    // something real happened — and it is the signal correlation will later act on.
    if (row.lat !== null && row.lng !== null) {
      const others = db
        .query<{ source: string; n: number }, (string | number)[]>(
          `SELECT source, count(*) AS n FROM observations
            WHERE id <> ? AND source <> ?
              AND occurred_at BETWEEN ? AND ?
              AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
            GROUP BY source`,
        )
        .all(
          row.id,
          row.source,
          new Date(new Date(row.occurred_at).getTime() - 30 * 60_000).toISOString(),
          new Date(new Date(row.occurred_at).getTime() + 30 * 60_000).toISOString(),
          row.lat - 0.004,
          row.lat + 0.004,
          row.lng - 0.005,
          row.lng + 0.005,
        );
      if (others.length > 0) {
        score += 2 + others.length;
        reasons.push(`${others.map((other) => other.source.replace("sf_", "").replace("_cad", "")).join(" and ")} also responded nearby`);
      }
    }

    if (weight >= 4) reasons.unshift(`a ${row.type} call, which is uncommon`);
    return { row, score, reasons };
  });

  return ranked
    .sort((a, b) => b.score - a.score || b.row.occurred_at.localeCompare(a.row.occurred_at))
    .slice(0, limit);
}

export function runAsk(db: Database, query: AskQuery, now: Date = new Date()): AskAnswer {
  const { sql, parameters } = conditions(query, now);
  const columns =
    "id, source, source_record_id, occurred_at, ingested_at, type, type_confidence, raw_type, subtype, priority, priority_rank, location_raw, location_normalized, neighborhood, lat, lng, location_method, units, sensitive, backfilled";

  const rows = db
    .query<ObservationListRow, (string | number)[]>(
      `SELECT ${columns} FROM observations ${sql} ORDER BY occurred_at DESC LIMIT 200`,
    )
    .all(...parameters);

  const total =
    db
      .query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM observations ${sql}`)
      .get(...parameters)?.n ?? 0;

  const breakdown = db
    .query<{ type: string; n: number }, (string | number)[]>(
      `SELECT COALESCE(type, 'unknown') AS type, count(*) AS n FROM observations ${sql}
        GROUP BY type ORDER BY n DESC LIMIT 8`,
    )
    .all(...parameters);

  const withheldLocations =
    db
      .query<{ n: number }, (string | number)[]>(
        `SELECT count(*) AS n FROM observations ${sql ? `${sql} AND` : "WHERE"} lat IS NULL`,
      )
      .get(...parameters)?.n ?? 0;

  // The same window, immediately before it — context without a claim about "normal".
  let previousTotal = 0;
  if (query.windowMinutes > 0) {
    const previous = conditions(
      query,
      new Date(now.getTime() - query.windowMinutes * 60_000),
    );
    previousTotal =
      db
        .query<{ n: number }, (string | number)[]>(
          `SELECT count(*) AS n FROM observations ${previous.sql} AND occurred_at < ?`,
        )
        .get(
          ...previous.parameters,
          new Date(now.getTime() - query.windowMinutes * 60_000).toISOString(),
        )?.n ?? 0;
  }

  return {
    query,
    total,
    rows,
    ranked: query.intent === "highlight" ? rank(db, rows) : [],
    breakdown,
    withheldLocations,
    previousTotal,
  };
}
