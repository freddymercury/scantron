/**
 * Combining lexical retrieval with Jev's relevance scores.
 *
 * The gate is the important part: a judgement below its confidence threshold changes
 * nothing. Half-applying an uncertain answer is how a ranking becomes unexplainable, and
 * this one has to stay explainable — every position it produces is defended in the UI.
 */

import type { ObservationListRow } from "../internal/queries.ts";
import type { JevClient, JevResponse } from "./jev.ts";
import { buildRetrievalRequest, buildSearchRequest, RELEVANCE_LEVELS } from "./jev.ts";
import type { SearchHit } from "./search.ts";

/** Below these, the answer is ignored rather than partly believed. */
export const GATE = {
  relevance: 0.35,
  choice: 0.45,
  noul: 0.6,
} as const;

export interface RerankedHit extends SearchHit {
  /** 0–4 on the RELEVANCE_LEVELS ladder, when Jev answered confidently. */
  relevance?: number;
  relevanceConfidence?: number;
  relevanceLabel?: string;
  finalScore: number;
}

export interface RerankResult {
  hits: RerankedHit[];
  /** True when Jev answered and its answers were used. */
  reranked: boolean;
  /** Why not, when not — shown in the UI rather than hidden. */
  fallbackReason?: string;
  activityKind?: string;
  wantsRecent?: boolean;
  wantsPlace?: boolean;
  latencyMs?: number;
  /** What the question was expanded to before retrieval, in reader-facing words. */
  expandedTo?: string[];
  /** How many candidates came from a category match rather than a keyword match. */
  retrievedByCategory?: number;
}

function normalizeLexical(hits: SearchHit[]): number[] {
  const scores = hits.map((hit) => hit.lexicalScore);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  return scores.map((score) => (span === 0 ? 0.5 : (score - min) / span));
}

export function applyAnswers(hits: SearchHit[], response: JevResponse): RerankedHit[] {
  const lexical = normalizeLexical(hits);

  return hits.map((hit, index) => {
    const answer = response.answers[`rel_${index}`];
    const normalized = lexical[index] ?? 0;

    if (!answer || answer.type !== "score" || answer.confidence < GATE.relevance) {
      return { ...hit, finalScore: normalized };
    }
    // The score is fractional (an expected value over the levels), so the ranking uses it
    // as-is and only the human-readable label is rounded.
    const relevance = answer.score / (RELEVANCE_LEVELS.length - 1);
    const label = RELEVANCE_LEVELS[Math.round(answer.score)];
    return {
      ...hit,
      relevance: answer.score,
      relevanceConfidence: answer.confidence,
      ...(label === undefined ? {} : { relevanceLabel: label }),
      // Semantic relevance leads, lexical rank breaks ties: the retriever decided what is
      // in the running, the model decides the order within it.
      finalScore: relevance * 0.8 + normalized * 0.2,
    };
  });
}

export async function rerank(
  client: JevClient,
  query: string,
  hits: SearchHit[],
): Promise<RerankResult> {
  const lexicalOnly = (reason: string): RerankResult => ({
    hits: hits.map((hit, index) => ({ ...hit, finalScore: normalizeLexical(hits)[index] ?? 0 })),
    reranked: false,
    fallbackReason: reason,
  });

  if (!client.available) return lexicalOnly("no JEV_API_KEY configured — lexical ranking only");
  if (hits.length === 0) return lexicalOnly("nothing to rank");

  const response = await client.ask(buildSearchRequest(query, hits.map((hit) => hit.row)));
  if (!response) {
    return lexicalOnly(
      client.stats.timeouts > 0
        ? "the re-rank did not land inside its latency budget, so the lexical order stands"
        : "the re-rank request failed, so the lexical order stands",
    );
  }

  const ranked = applyAnswers(hits, response).sort((a, b) => b.finalScore - a.finalScore);
  const result: RerankResult = { hits: ranked, reranked: true, latencyMs: client.stats.lastMs };

  const kind = response.answers.activity_kind;
  if (kind?.type === "choice" && kind.confidence >= GATE.choice) result.activityKind = kind.choice;
  const recent = response.answers.wants_recent;
  if (recent?.type === "noul" && recent.noul >= GATE.noul) result.wantsRecent = true;
  const place = response.answers.wants_place;
  if (place?.type === "noul" && place.noul >= GATE.noul) result.wantsPlace = true;

  return result;
}

export type { ObservationListRow };

/** How far below the strongest judgement a type may sit and still be retrieved. */
export const RETRIEVAL_SPREAD = 0.15;
export const MAX_RETRIEVAL_TYPES = 3;

/**
 * Catch-all buckets in the taxonomy. They score high on almost anything — measured:
 * `public_safety` came back 0.83 on "gunshots" — so widening a query with one alongside a
 * specific type buries what was asked for under suspicious-person calls. They are retrieved
 * only when nothing more specific was judged at all.
 */
export const CATCH_ALL_TYPES = new Set(["public_safety", "police_activity", "unknown"]);

export interface RetrievalPlan {
  /** Types Jev judged the question to be about, above the gate. */
  types: string[];
  /** Why, in the words shown to the reader. */
  reason?: string;
  latencyMs?: number;
}

/**
 * Ask which kinds of call the question is about, *before* retrieving. This is what gives
 * search recall it cannot get from keywords: "gunshots" retrieves weapon calls because the
 * question was judged to be about weapons, not because any record contains that word.
 */
export async function planRetrieval(
  client: JevClient,
  query: string,
  types: readonly string[],
): Promise<RetrievalPlan> {
  if (!client.available) return { types: [] };

  const response = await client.ask(buildRetrievalRequest(query, types));
  if (!response) return { types: [] };

  // Relative to the strongest answer, not an absolute bar. Measured on "gunshots":
  // weapon 0.98, public_safety 0.83, disturbance 0.66, medical 0.61 — a flat 0.6 gate
  // retrieves four categories for a question that is about one. Keeping what is close to
  // the top, capped at three, retrieves what was asked about.
  const scored = types
    .map((type) => {
      const answer = response.answers[`type_${type}`];
      return { type, noul: answer?.type === "noul" ? answer.noul : 0 };
    })
    .filter((entry) => entry.noul >= GATE.noul)
    .sort((a, b) => b.noul - a.noul);

  // When *nothing* specific was judged, the honest answer is that our taxonomy has no
  // category for this question — not `public_safety`, which is 2,069 calls in 90 days and
  // buries the handful actually asked about. Returning no plan hands the question to
  // keyword search, which can still find "Solicits For Act Of Prostitution" by its words.
  const specific = scored.filter((entry) => !CATCH_ALL_TYPES.has(entry.type));
  if (specific.length === 0) {
    return {
      types: [],
      reason: "no category in this taxonomy matches the question",
      latencyMs: client.stats.lastMs,
    };
  }

  const top = specific[0]?.noul ?? 0;
  const chosen = specific
    .filter((entry) => entry.noul >= top - RETRIEVAL_SPREAD)
    .slice(0, MAX_RETRIEVAL_TYPES)
    .map((entry) => entry.type);
  const plan: RetrievalPlan = { types: chosen, latencyMs: client.stats.lastMs };
  if (chosen.length > 0) plan.reason = `judged to be about ${chosen.join(", ")} calls`;
  return plan;
}
