/**
 * Combining lexical retrieval with Jev's relevance scores.
 *
 * The gate is the important part: a judgement below its confidence threshold changes
 * nothing. Half-applying an uncertain answer is how a ranking becomes unexplainable, and
 * this one has to stay explainable — every position it produces is defended in the UI.
 */

import type { ObservationListRow } from "../internal/queries.ts";
import type { JevClient, JevResponse } from "./jev.ts";
import { buildSearchRequest, RELEVANCE_LEVELS } from "./jev.ts";
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
    const relevance = answer.score / (RELEVANCE_LEVELS.length - 1);
    const label = RELEVANCE_LEVELS[answer.score];
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
