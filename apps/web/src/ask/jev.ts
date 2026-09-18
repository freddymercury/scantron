/**
 * Jev (TypeSafe systemone) — semantic re-ranking for search, as *decisions* rather than
 * prose.
 *
 * Why this model can sit in this codebase at all, when docs/06 rules out generated text:
 * Jev's entire output is answers to questions we define — a score with a probability
 * distribution over ordered levels, a choice from an enum we supply, a boolean. It cannot
 * emit a sentence a reader sees, because sentences are not in its output alphabet. That is
 * the 12-factor Factor 4 boundary enforced by the protocol instead of by our validator.
 *
 * It is optional. With no key configured, search is lexical only (FTS5) and nothing
 * degrades except ordering. Latency is the point of the model, so a slow answer is dropped
 * rather than waited for: a re-rank that lands after the reader has moved on is worse than
 * no re-rank, because it reorders results they were already reading.
 */

import type { ObservationListRow } from "../internal/queries.ts";

export const JEV_MODEL = "jev-latest";
/** Published on OpenRouter, 2026-09-18: $0.042 per million input tokens, output free. */
export const PRICE_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, string> | readonly string[];
}

export interface JevRequest {
  state: unknown;
  model: string;
  questions: Record<string, JevQuestion>;
}

interface RawScore {
  type: "score";
  /**
   * A *fractional* position on the ladder — 1.83, not 2. It is the expected value over the
   * level probabilities, which is more information than an argmax and the reason the label
   * shown to a reader is rounded while the ranking uses the raw number.
   */
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}
interface RawChoice {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
interface RawNoul {
  type: "noul";
  noul: number;
}
export type JevAnswer = RawScore | RawChoice | RawNoul;

export interface JevResponse {
  /** The resolved version, e.g. `typesafe/jev-1.13-20260917` — worth logging. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
  id?: string;
  provider?: string;
}

/**
 * How well a record answers what was asked. Ordered levels, because a score with no stated
 * ladder is a number nobody can check.
 */
export const RELEVANCE_LEVELS = [
  "Unrelated to what the reader asked about",
  "Same general area of activity, but not what they asked about",
  "Partially matches; related but not the thing itself",
  "Good match for what they asked about",
  "Exactly what they asked about",
] as const;

export interface CandidateState {
  id: string;
  reported_as: string;
  agency_code: string | null;
  type: string | null;
  where: string | null;
  neighborhood: string | null;
  units: string[];
  dispatch_priority: number | null;
  when: string;
  source: string;
}

/**
 * What Jev is shown. Note what is absent: no source free-text, no raw payload, no
 * identifiers beyond our own opaque ids. The model sees what a published record would show
 * (S-E1), which keeps a third-party service on the right side of the publication rule.
 */
export function toCandidateState(row: ObservationListRow): CandidateState {
  return {
    id: row.id,
    reported_as: row.subtype ?? row.type ?? "unknown",
    agency_code: row.raw_type,
    type: row.type,
    where: row.location_normalized ?? row.location_raw,
    neighborhood: row.neighborhood,
    units: row.units ? (JSON.parse(row.units) as string[]) : [],
    dispatch_priority: row.priority_rank,
    when: row.occurred_at,
    source: row.source,
  };
}

export function relevanceQuestion(path: string): JevQuestion {
  return {
    type: "score",
    instructions:
      `How well does the dispatch record at \`${path}\` match what the reader asked for in \`query\`? ` +
      "Judge what was reported and where it happened against what they asked about, including any place " +
      "or kind of activity they named. Sharing a word with the query does not make it a match — a traffic " +
      "stop is not a car break-in. Judge only what was dispatched; say nothing about how serious it was.",
    criteria: RELEVANCE_LEVELS,
  };
}

/**
 * Query-level questions. Deliberately about *what was asked*, never about the city:
 * "is this reader asking about a specific place" is a question about their sentence, while
 * "is this neighborhood dangerous" is one we refuse to ask anything.
 */
export const QUERY_QUESTIONS: Record<string, JevQuestion> = {
  wants_recent: {
    type: "noul",
    instructions: "Does the reader's `query` ask about something happening now or very recently?",
    criteria: {
      true: "The query says now, currently, right now, just happened, tonight, or otherwise asks about the immediate present",
      false: "The query asks about a longer period, a past day or week, or states no time at all",
    },
  },
  wants_place: {
    type: "noul",
    instructions: "Does the reader's `query` name a specific street, intersection or landmark, rather than a whole neighborhood?",
    criteria: {
      true: "The query names a street, a corner, a park, a station, a building or another specific location",
      false: "The query names a neighborhood, the whole city, or no place at all",
    },
  },
  activity_kind: {
    type: "choice",
    instructions: "Which kind of dispatch activity is the reader's `query` asking about?",
    criteria: {
      property: "Theft, burglary, vehicle break-ins, vandalism — things taken or damaged",
      violence: "Assault, weapons, robbery, fights — a person harmed or threatened",
      fire: "Fires, smoke, alarms, hazardous materials",
      medical: "Medical calls, ambulances, overdoses, welfare checks",
      traffic: "Collisions, traffic stops, road hazards",
      disorder: "Noise, disturbances, trespassing, quality-of-life complaints",
      any: "The query does not point to one kind of activity",
    },
  },
};

/**
 * Step 2 of two-step retrieval: ask what *kind* of call the question is about, before
 * deciding what to retrieve.
 *
 * One boolean per product type rather than a single choice, because a question can be
 * about more than one ("break-in" is burglary and theft) and a forced single answer would
 * throw half of it away. The questions are about the reader's sentence, never about the
 * city — nothing here asks whether anywhere is dangerous.
 */
export function typeQuestions(types: readonly string[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const type of types) {
    questions[`type_${type}`] = {
      type: "noul",
      instructions: `Is the reader's \`query\` asking about ${TYPE_DESCRIPTIONS[type] ?? type} calls?`,
      criteria: {
        true: `The query describes ${TYPE_DESCRIPTIONS[type] ?? type}, in any wording`,
        false: "The query is about something else, or names no kind of activity",
      },
    };
  }
  return questions;
}

/** Plain-language descriptions of the PRD §10 taxonomy, for the retrieval questions. */
export const TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  fire: "fire, smoke, or burning",
  medical: "a medical emergency, injury, overdose, or ambulance",
  collision: "a vehicle crash, a car hitting a person, or a hit and run",
  assault: "one person attacking or fighting another",
  weapon: "a gun, a knife, gunfire or shots being fired",
  robbery: "something taken from a person by force or threat",
  burglary: "someone breaking into a building or home",
  theft: "something stolen, including from a vehicle",
  disturbance: "noise, yelling, vandalism, or a nuisance",
  missing_person: "a missing person",
  hazard: "a gas leak, spill, hazardous material or unsafe condition",
  rescue: "a rescue — water, height, entrapment, or extrication",
  traffic: "a traffic stop, citation, or road obstruction",
  // These two are catch-alls in the taxonomy, so their descriptions have to be narrow or
  // they answer "yes" to everything — measured: public_safety scored 0.83 on "gunshots".
  public_safety: "suspicious activity or a welfare concern that is not any of the other kinds",
  police_activity: "routine police business such as alarms, prisoner transports or assists",
  unknown: "something that fits none of the other kinds at all",
};

export function buildRetrievalRequest(query: string, types: readonly string[]): JevRequest {
  return {
    model: JEV_MODEL,
    state: { query },
    questions: { ...typeQuestions(types), ...QUERY_QUESTIONS },
  };
}

export interface JevClientOptions {
  /** `JEV_API_KEY`. With none, the client reports itself unavailable and search stays lexical. */
  apiKey?: string | undefined;
  /** `JEV_BASE_URL`; TypeSafe direct by default, or an OpenRouter-compatible gateway. */
  baseUrl?: string | undefined;
  /** A re-rank that lands after the reader has moved on is worse than none. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  model?: string;
}

export interface JevStats {
  requests: number;
  failures: number;
  timeouts: number;
  inputTokens: number;
  lastMs: number;
  totalMs: number;
  costUsd: number;
  /** The resolved model version the provider actually answered with. */
  model?: string;
}

export interface JevClient {
  readonly available: boolean;
  readonly stats: JevStats;
  ask(request: JevRequest): Promise<JevResponse | undefined>;
}

/**
 * OpenRouter serves this family on a dedicated decisions endpoint — a chat/completions
 * call is rejected with "is a decisions model and cannot be used with the chat/completions
 * endpoint", which is a pleasing way for an API to enforce the same boundary this codebase
 * cares about. TypeSafe's own `https://api.typesafe.ai/v1/systemone` takes the same body.
 */
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/alpha/decisions";

export function createJevClient(options: JevClientOptions = {}): JevClient {
  const apiKey = options.apiKey ?? process.env.JEV_API_KEY?.trim();
  const baseUrl = options.baseUrl ?? process.env.JEV_BASE_URL?.trim() ?? DEFAULT_BASE_URL;
  // Measured against OpenRouter from a laptop on 2026-09-18: p50 235–261 ms, p90 294–911 ms
  // for 10–30 candidates. 1,200 ms leaves headroom for the tail without letting a stalled
  // request sit in front of a rendered page. A keystroke-latency budget would need fewer
  // candidates and a closer endpoint.
  const timeoutMs = options.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? 1200);
  const doFetch = options.fetchImpl ?? fetch;

  const stats: JevStats = {
    requests: 0,
    failures: 0,
    timeouts: 0,
    inputTokens: 0,
    lastMs: 0,
    totalMs: 0,
    costUsd: 0,
  };

  return {
    available: Boolean(apiKey),
    stats,
    async ask(request: JevRequest): Promise<JevResponse | undefined> {
      if (!apiKey) return undefined;

      const startedAt = performance.now();
      stats.requests += 1;
      try {
        // Both a signal and a race: the signal is the polite way to cancel, the race is
        // what actually bounds the wait if a transport ignores it. The deadline is the
        // feature here, so it is not left to the other end to honour.
        const response = await Promise.race([
          doFetch(baseUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...request, model: options.model ?? request.model ?? JEV_MODEL }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
          Bun.sleep(timeoutMs).then(() => {
            const timeout = new Error(`jev did not answer within ${timeoutMs}ms`);
            timeout.name = "TimeoutError";
            throw timeout;
          }),
        ]);
        stats.lastMs = performance.now() - startedAt;
        stats.totalMs += stats.lastMs;

        if (!response.ok) {
          stats.failures += 1;
          return undefined;
        }
        const parsed = (await response.json()) as JevResponse;
        const tokens = parsed.usage?.input_tokens ?? 0;
        stats.inputTokens += tokens;
        // Prefer the cost the provider reports; fall back to the published input rate.
        stats.costUsd += parsed.usage?.cost ?? tokens * PRICE_PER_INPUT_TOKEN_USD;
        stats.model = parsed.model;
        return parsed;
      } catch (error) {
        stats.lastMs = performance.now() - startedAt;
        stats.totalMs += stats.lastMs;
        // A timeout is the expected failure, not an exceptional one: search carries on
        // with the lexical ordering it already had.
        if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
          stats.timeouts += 1;
        } else {
          stats.failures += 1;
        }
        return undefined;
      }
    },
  };
}

export function buildSearchRequest(query: string, candidates: ObservationListRow[]): JevRequest {
  const questions: Record<string, JevQuestion> = {};
  candidates.forEach((_, index) => {
    questions[`rel_${index}`] = relevanceQuestion(`candidates[${index}]`);
  });
  Object.assign(questions, QUERY_QUESTIONS);

  return {
    model: JEV_MODEL,
    state: { query, candidates: candidates.map(toCandidateState) },
    questions,
  };
}
