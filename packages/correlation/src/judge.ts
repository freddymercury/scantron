/**
 * A second opinion on the pairs the scorer is unsure about.
 *
 * The deterministic scorer decides 96% of pairs and stays in charge of them. This asks a
 * decision model about the rest — the probable band — for one reason the harness measured:
 * our type taxonomy is too coarse in places. PRD §10 keeps the type list deliberately
 * broad, so `FIGHT NO WEAPON` and `VANDALISM` are both `disturbance`, and only one of them
 * brings an ambulance. A judge that reads the agency's own words can tell them apart; our
 * affinity matrix, by construction, cannot.
 *
 * What it is not allowed to do:
 *   * write anything a reader sees — it answers typed questions, nothing else;
 *   * see source free-text or any identifier (S-E1);
 *   * overturn a confident decision — it is consulted only inside the probable band;
 *   * be required — with no key, or a slow answer, correlation behaves exactly as before.
 */

import type { CandidateObservation, IncidentCandidate } from "./candidates.ts";

export const SAME_EVENT_LEVELS = [
  "Definitely different events that happen to be near each other",
  "Probably different events",
  "Could be either; the records do not say",
  "Probably the same event, reported by two agencies",
  "Definitely the same event",
] as const;

export interface JudgeQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | readonly string[];
}

export interface JudgeRequest {
  model: string;
  state: unknown;
  questions: Record<string, JudgeQuestion>;
}

export interface JudgeAnswer {
  type: string;
  score?: number;
  noul?: number;
  confidence?: number;
}

export interface JudgeResponse {
  model: string;
  answers: Record<string, JudgeAnswer>;
  usage?: { input_tokens: number; cost?: number };
}

/** Published rate, used when the provider does not report cost itself. */
export const PRICE_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

export interface JudgeVerdict {
  /** 0–4 on the SAME_EVENT_LEVELS ladder, as a fractional expected value. */
  sameEvent: number;
  confidence: number;
  label: string;
  /** True when the judge was confident enough to be acted on. */
  actionable: boolean;
  latencyMs: number;
  model?: string;
  costUsd?: number;
}

export interface JudgeClient {
  readonly available: boolean;
  ask(request: JudgeRequest): Promise<JudgeResponse | undefined>;
}

/** What the judge is shown: what a published record shows, and nothing else. */
export function judgeState(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
  distanceMeters?: number,
): unknown {
  const gapMinutes =
    (observation.occurredAt.getTime() - Date.parse(candidate.firstObservedAt)) / 60_000;

  return {
    new_report: {
      reported_as: observation.rawType ?? observation.type ?? "unknown",
      agency: observation.source.replace("sf_", "").replace("_cad", ""),
      where: observation.locationCanonical ?? observation.neighborhood ?? "unknown",
      units: observation.units ?? [],
    },
    open_incident: {
      reported_as: candidate.rawType ?? candidate.primaryType,
      agencies: candidate.agencyTypes,
      where: candidate.locationDisplayName ?? candidate.neighborhood ?? "unknown",
      units: candidate.units,
      status: candidate.status,
    },
    minutes_apart: Number(gapMinutes.toFixed(1)),
    ...(distanceMeters === undefined ? {} : { metres_apart: Math.round(distanceMeters) }),
  };
}

export function buildJudgeRequest(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
  model = "jev-latest",
): JudgeRequest {
  return {
    model,
    state: judgeState(observation, candidate, candidate.distanceMeters),
    questions: {
      same_event: {
        type: "score",
        instructions:
          "Is `new_report` the same real-world event as `open_incident`? Two agencies " +
          "responding to one event describe it differently — a police assault call and an " +
          "ambulance, a collision and a medic — and that is the same event. Two unrelated " +
          "calls at one busy corner minutes apart are not. Judge what was reported, how far " +
          "apart, and how long apart. Say nothing about how serious either is.",
        criteria: SAME_EVENT_LEVELS,
      },
    },
  };
}

/**
 * Both gates come from measurement, not taste. Over the 16 probable-band pairs in the
 * labelled set:
 *
 *   score alone does not separate — a pair labelled *different* scored 2.85, higher than
 *   four pairs labelled *same*. **Confidence does the separating**: the wrong answers came
 *   back at 0.00–0.37, the right ones at 0.42–0.72.
 *
 * At score ≥ 2.4 and confidence ≥ 0.6 the judge promotes 3 pairs, all correct, and adds no
 * false merges. Dropping the confidence gate to 0.5 promotes 5 and adds 1 wrong — and a
 * false merge is the failure a reader sees, so the conservative pair wins.
 */
export const JUDGE_CONFIDENCE_GATE = 0.6;
/** Expected value on the ladder, so "probably the same" lands near 2.8 rather than 3.0. */
export const JUDGE_MERGE_LEVEL = 2.4;

export async function judgePair(
  client: JudgeClient,
  observation: CandidateObservation,
  candidate: IncidentCandidate,
): Promise<JudgeVerdict | undefined> {
  if (!client.available) return undefined;

  const startedAt = performance.now();
  const response = await client.ask(buildJudgeRequest(observation, candidate));
  const latencyMs = performance.now() - startedAt;
  if (!response) return undefined;

  const answer = response.answers.same_event;
  if (!answer || answer.type !== "score" || answer.score === undefined) return undefined;

  const confidence = answer.confidence ?? 0;
  const verdict: JudgeVerdict = {
    sameEvent: answer.score,
    confidence,
    label: SAME_EVENT_LEVELS[Math.round(answer.score)] ?? "",
    actionable: confidence >= JUDGE_CONFIDENCE_GATE,
    latencyMs,
  };
  if (response.model) verdict.model = response.model;
  if (response.usage?.cost !== undefined) verdict.costUsd = response.usage.cost;
  return verdict;
}

/**
 * The judge may only move a pair *within* the uncertainty it was consulted about: promote a
 * probable pair to a merge, or push it down to a new incident. It can never overturn a
 * decision the scorer was confident about, because then it would be the scorer.
 */
export function applyVerdict(
  decision: "merged" | "probable" | "created",
  verdict: JudgeVerdict | undefined,
): { decision: "merged" | "probable" | "created"; reason?: string } {
  if (!verdict || !verdict.actionable || decision !== "probable") return { decision };

  if (verdict.sameEvent >= JUDGE_MERGE_LEVEL) {
    return {
      decision: "merged",
      reason: `judge: ${verdict.label} (${verdict.sameEvent.toFixed(2)}, confidence ${verdict.confidence.toFixed(2)})`,
    };
  }
  if (verdict.sameEvent <= 1.2) {
    return {
      decision: "created",
      reason: `judge: ${verdict.label} (${verdict.sameEvent.toFixed(2)}, confidence ${verdict.confidence.toFixed(2)})`,
    };
  }
  return { decision: "probable", reason: `judge unsure: ${verdict.label}` };
}

export interface JevJudgeOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  model?: string;
}

export interface JevJudgeStats {
  requests: number;
  failures: number;
  timeouts: number;
  costUsd: number;
  totalMs: number;
}

/**
 * The judge over the wire. Same shape as the search re-ranker: optional, deadline-bounded
 * on our side, and silent about failure — correlation carries on without it.
 */
export function createJevJudge(
  options: JevJudgeOptions = {},
): JudgeClient & { stats: JevJudgeStats } {
  const apiKey = options.apiKey ?? process.env.JEV_API_KEY?.trim();
  const baseUrl =
    options.baseUrl ?? process.env.JEV_BASE_URL?.trim() ?? "https://openrouter.ai/api/alpha/decisions";
  const timeoutMs = options.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 1200);
  const doFetch = options.fetchImpl ?? fetch;
  const stats: JevJudgeStats = { requests: 0, failures: 0, timeouts: 0, costUsd: 0, totalMs: 0 };

  return {
    stats,
    available: Boolean(apiKey),
    async ask(request: JudgeRequest): Promise<JudgeResponse | undefined> {
      if (!apiKey) return undefined;
      const startedAt = performance.now();
      stats.requests += 1;
      try {
        const response = await Promise.race([
          doFetch(baseUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ ...request, model: options.model ?? request.model }),
          }),
          Bun.sleep(timeoutMs).then(() => {
            const timeout = new Error("judge timed out");
            timeout.name = "TimeoutError";
            throw timeout;
          }),
        ]);
        stats.totalMs += performance.now() - startedAt;
        if (!response.ok) {
          stats.failures += 1;
          return undefined;
        }
        const parsed = (await response.json()) as JudgeResponse;
        // OpenRouter reports cost; TypeSafe direct reports only tokens, so fall back to
        // the published input rate rather than recording spend as zero.
        stats.costUsd +=
          parsed.usage?.cost ?? (parsed.usage?.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN_USD;
        return parsed;
      } catch (error) {
        stats.totalMs += performance.now() - startedAt;
        if ((error as Error).name === "TimeoutError") stats.timeouts += 1;
        else stats.failures += 1;
        return undefined;
      }
    },
  };
}
