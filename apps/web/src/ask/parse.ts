/**
 * Question → structured query (S-H4 Tier 1).
 *
 * Two rules shape this file. The parser picks a query and never writes prose. And every
 * parse states its interpretation, so a misreading is visible and correctable rather than
 * a silently wrong answer.
 */

import type { IncidentType } from "@scantron/incident-schema";

import {
  AREA_ALIASES,
  CATEGORIES,
  TIME_PHRASES,
  UNANSWERABLE,
  UNIT_MINUTES,
} from "./grammar.ts";

export type AskIntent = "list" | "highlight" | "count";

export interface AskQuery {
  intent: AskIntent;
  /** Analysis Neighborhood name, when one was recognized. */
  area?: string;
  /** Minutes back from now. 0 means "everything". */
  windowMinutes: number;
  windowLabel: string;
  types: IncidentType[];
  rawCodes: string[];
  categoryLabel?: string;
  /** Words that looked meaningful but matched nothing — shown back to the reader. */
  unresolved: string[];
  /** Set when the question asks something dispatch data cannot answer. */
  unanswerable?: string;
  question: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  sixty: 60,
  ninety: 90,
};

const DEFAULT_WINDOW_MINUTES = 3 * 60;

function normalize(question: string): string {
  return question
    .toLowerCase()
    // "what's" → "what", not "what s": a stray "s" looked like a word we did not know.
    .replace(/['\u2019]s\b/g, "")
    .replace(/[?!.,;:"'\u2019]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "last 90 minutes", "past 2 hrs", "in the last three days", "over the past day". */
const WINDOW_RE =
  /\b(?:in|within|over|during|for)?\s*(?:the\s+)?(?:last|past|previous)\s+(\d+|a|an|one|two|three|four|five|six|ten|twelve|fifteen|twenty|thirty|sixty|ninety)?\s*([a-z]+)/;
const BARE_WINDOW_RE =
  /\b(\d+)\s*(min|mins|minutes|hour|hours|hr|hrs|h|day|days|d|week|weeks|month|months)\b/;

export function parseNumericWindow(text: string): { minutes: number; label: string } | undefined {
  const match = WINDOW_RE.exec(text) ?? BARE_WINDOW_RE.exec(text);
  if (!match) return undefined;

  const rawCount = match[1];
  // "the last hour" and "over the past day" carry no number, and mean one of them.
  const count = rawCount === undefined ? 1 : /^\d+$/.test(rawCount) ? Number(rawCount) : (NUMBER_WORDS[rawCount] ?? Number.NaN);
  const word = (match[2] ?? "").replace(/s$/, "");
  const unit = UNIT_MINUTES[word] ?? UNIT_MINUTES[match[2] as string];
  if (!Number.isFinite(count) || unit === undefined) return undefined;

  const minutes = count * unit;
  const unitName =
    unit === 1 ? "minute" : unit === 60 ? "hour" : unit === 1440 ? "day" : unit === 10080 ? "week" : unit === 43200 ? "month" : "year";
  // "last week" is echoed as "the last week", not "the last 1 week" — the reader did not
  // write a number and should not be read one back.
  const label = rawCount === undefined ? `the last ${unitName}` : `the last ${count} ${unitName}${count === 1 ? "" : "s"}`;
  return { minutes, label };
}

function matchArea(text: string, known: readonly string[]): { name: string; phrase: string } | undefined {
  // Longest alias first, so "outer sunset" beats "sunset".
  const aliases = Object.keys(AREA_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
      return { name: AREA_ALIASES[alias] as string, phrase: alias };
    }
  }
  // Then the city's own names, for anything the alias table does not cover.
  const byLength = [...known].sort((a, b) => b.length - a.length);
  for (const name of byLength) {
    if (text.includes(name.toLowerCase())) return { name, phrase: name.toLowerCase() };
  }
  return undefined;
}

/** Removes a matched phrase and any plural tail, so leftovers are genuinely leftovers. */
function strip(text: string, phrase: string): string {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}s?`, "g"), " ").replace(/\s+/g, " ").trim();
}

export function phraseIn(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(text);
}

function matchCategory(
  text: string,
): { types: IncidentType[]; rawCodes: string[]; label: string; phrase: string } | undefined {
  const candidates = CATEGORIES.flatMap((rule) =>
    rule.phrases.map((phrase) => ({ phrase, rule })),
  ).sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { phrase, rule } of candidates) {
    // Word boundaries, not substrings: "od" inside "today" once turned every question
    // about today into a question about overdoses.
    if (phraseIn(text, phrase)) {
      return {
        types: [...(rule.types ?? [])],
        rawCodes: [...(rule.rawCodes ?? [])],
        label: rule.label,
        phrase,
      };
    }
  }
  return undefined;
}

function matchIntent(text: string): AskIntent {
  if (/\b(how many|count|number of|how much)\b/.test(text)) return "count";
  if (
    /\b(most interesting|anything|what happening|whats happening|what is happening|going on|what going on|biggest|worst|notable|highlight)\b/.test(
      text,
    )
  ) {
    return "highlight";
  }
  return "list";
}

const STOPWORDS = new Set(
  ("the a an in on at of for to and or is are was were what whats show me give all any there here near " +
    "my around please tell about last past previous within happening going on this that it its right now " +
    "today tonight over from with most interesting anything something how many much number count things " +
    "biggest worst notable highlight s time nearby " +
    "thing stuff going lately recently latest new newest incidents incident calls call activity anyone " +
    "been did do does going happened list see view find search").split(" "),
);

export function parseQuestion(
  question: string,
  options: { knownAreas?: readonly string[] } = {},
): AskQuery {
  const text = normalize(question);
  const known = options.knownAreas ?? [];

  const query: AskQuery = {
    intent: matchIntent(text),
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    windowLabel: "the last 3 hours",
    types: [],
    rawCodes: [],
    unresolved: [],
    question,
  };

  const numeric = parseNumericWindow(text);
  if (numeric) {
    query.windowMinutes = numeric.minutes;
    query.windowLabel = numeric.label;
  } else {
    const phrase = TIME_PHRASES.find((candidate) => candidate.pattern.test(text));
    if (phrase) {
      query.windowMinutes = phrase.minutes;
      query.windowLabel = phrase.label;
    }
  }

  const areaMatch = matchArea(text, known);
  if (areaMatch) query.area = areaMatch.name;

  const category = matchCategory(text);
  if (category) {
    query.types = category.types;
    query.rawCodes = category.rawCodes;
    query.categoryLabel = category.label;
  }

  // Checked last: a question can be well-formed and still be one we must not answer.
  const unanswerable = UNANSWERABLE.find((candidate) => candidate.pattern.test(text));
  if (unanswerable) query.unanswerable = unanswerable.because;

  // Leftovers are computed from what is actually left after every match is removed, so a
  // recognized phrase never shows up as "I did not understand this".
  let remainder = text;
  if (numeric) {
    remainder = remainder
      .replace(new RegExp(WINDOW_RE.source, "g"), " ")
      .replace(new RegExp(BARE_WINDOW_RE.source, "g"), " ");
  } else {
    for (const phrase of TIME_PHRASES) remainder = remainder.replace(new RegExp(phrase.pattern.source, "g"), " ");
  }
  if (areaMatch) remainder = strip(remainder, areaMatch.phrase);
  if (category) remainder = strip(remainder, category.phrase);

  for (const word of remainder.split(/\s+/)) {
    if (!word || STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word) || UNIT_MINUTES[word] !== undefined) continue;
    if (/^(min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|neighborhood|neighbourhood|area|district)$/.test(word)) continue;
    query.unresolved.push(word);
  }

  return query;
}

/** The sentence shown back to the reader: "car break-ins · Mission · the last 90 minutes". */
export function describeQuery(query: AskQuery): string {
  const parts = [query.categoryLabel ?? "all activity", query.area ?? "all of San Francisco", query.windowLabel];
  return parts.join(" · ");
}
