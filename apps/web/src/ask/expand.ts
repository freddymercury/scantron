/**
 * Query expansion (step 1 of two-step retrieval).
 *
 * The problem this fixes, measured on live data: "gunshots" returned **zero** candidates
 * while `SHOTS FIRED` and `PERSON W/GUN` records sat in the database. A stemmer does not
 * connect the word a person uses to the words an agency writes, and a semantic re-ranker
 * cannot rescue a search that retrieved nothing.
 *
 * So retrieval stops depending on shared words alone: a question is mapped to *types and
 * agency codes* through vocabulary we already have — the ask grammar's category phrases and
 * the labels in `event_taxonomy` — and those are searched alongside the keywords.
 */

import type { Database } from "bun:sqlite";
import type { IncidentType } from "@scantron/incident-schema";

import { CATEGORIES } from "./grammar.ts";
import { phraseIn } from "./parse.ts";

export interface Expansion {
  /** Words for the FTS index, as typed. */
  terms: string;
  types: IncidentType[];
  rawCodes: string[];
  /**
   * Codes in priority order, best first. This is what separates a car break-in from a
   * smashed shop window: both are plausible for "someone smashed a car window", but `852
   * AUTO BOOST / STRIP` is what was asked about and `594 VANDALISM` is the fallback. The
   * distinction lives in the agency's code, so a deterministic rank beats a semantic score
   * on evidence this thin — the record carries no narrative for a model to read.
   */
  codeOrder: string[];
  /** What produced the expansion, shown to the reader so the search explains itself. */
  matched: string[];
}

/**
 * Colloquial forms the category phrases do not carry. Kept small and specific: this is a
 * list of ways people say things, not a thesaurus.
 */
const COLLOQUIAL: readonly { phrases: readonly string[]; types: readonly IncidentType[]; rawCodes?: readonly string[]; label: string }[] = [
  { phrases: ["gunshot", "gunshots", "shooting", "shot", "shots"], types: ["weapon"], rawCodes: ["216", "216S", "221", "211S"], label: "gunfire" },
  // "smashed a car window" contains none of the two-word forms, which the live test found.
  { phrases: ["smashed", "smashing", "broken window", "broken glass", "window smashed"], types: ["theft"], rawCodes: ["852", "594"], label: "a smashed window" },
  { phrases: ["mugged", "mugging", "held up", "jumped"], types: ["robbery"], label: "robbery" },
  { phrases: ["hurt", "unconscious", "collapsed", "not breathing", "cpr"], types: ["medical"], label: "a medical emergency" },
  { phrases: ["smoke", "smoky", "burning", "flames"], types: ["fire"], label: "fire" },
  { phrases: ["hit by a car", "ran over", "pedestrian struck", "t boned", "rear ended"], types: ["collision"], label: "a collision" },
  { phrases: ["yelling", "screaming", "loud music", "fireworks"], types: ["disturbance"], rawCodes: ["415", "918"], label: "a disturbance" },
  { phrases: ["passed out", "od", "overdosing"], types: ["medical"], rawCodes: ["800", "801"], label: "a medical emergency" },
  { phrases: ["tagged", "graffiti", "vandalized", "vandalised"], types: ["disturbance"], rawCodes: ["594", "595"], label: "vandalism" },
  { phrases: ["stole my bike", "bike stolen", "bike theft"], types: ["theft"], label: "theft" },
  { phrases: ["break into", "breaking into", "broke into"], types: ["burglary", "theft"], rawCodes: ["459", "602", "852"], label: "a break-in" },
];

/**
 * Agency labels that contain a query word — `event_taxonomy` is the city's own vocabulary,
 * so "knife" finds `PERSON W/KNIFE` without anyone writing that mapping down.
 */
function codesFromTaxonomy(db: Database, words: readonly string[]): { codes: string[]; labels: string[] } {
  if (words.length === 0) return { codes: [], labels: [] };

  const clauses = words.map(() => "lower(raw_label) LIKE ?").join(" OR ");
  const rows = db
    .query<{ raw_code: string | null; raw_label: string | null }, string[]>(
      `SELECT raw_code, raw_label FROM event_taxonomy
        WHERE raw_code IS NOT NULL AND raw_label IS NOT NULL AND (${clauses})
        LIMIT 12`,
    )
    .all(...words.map((word) => `%${word}%`));

  return {
    codes: rows.map((row) => row.raw_code as string),
    labels: [...new Set(rows.map((row) => (row.raw_label as string).toLowerCase()))],
  };
}

const SKIP = new Set(
  "the and for with any all was were what whats show give near around about happening going this that there here someone somebody something anyone people person guy man woman my your their some".split(
    " ",
  ),
);

export function expandQuery(db: Database, text: string): Expansion {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const types = new Set<IncidentType>();
  const rawCodes = new Set<string>();
  const matched: string[] = [];
  // Lower is better. A code named first by the phrase that matched outranks one named
  // later, which outranks one found only by scanning agency labels.
  const rank = new Map<string, number>();
  const note = (code: string, weight: number) => {
    rawCodes.add(code);
    rank.set(code, Math.min(rank.get(code) ?? Number.POSITIVE_INFINITY, weight));
  };

  for (const rule of CATEGORIES) {
    const hit = rule.phrases.find((phrase) => phraseIn(normalized, phrase));
    if (!hit) continue;
    for (const type of rule.types ?? []) types.add(type);
    (rule.rawCodes ?? []).forEach((code, index) => note(code, index));
    matched.push(rule.label);
  }

  for (const rule of COLLOQUIAL) {
    const hit = rule.phrases.find((phrase) => phraseIn(normalized, phrase));
    if (!hit) continue;
    for (const type of rule.types) types.add(type);
    (rule.rawCodes ?? []).forEach((code, index) => note(code, index));
    matched.push(rule.label);
  }

  const words = normalized.split(" ").filter((word) => word.length > 3 && !SKIP.has(word));
  const fromTaxonomy = codesFromTaxonomy(db, words);
  // Found by scanning labels rather than named by a rule: useful, but never ahead of a
  // code the question matched directly.
  for (const code of fromTaxonomy.codes) note(code, 100);
  if (fromTaxonomy.labels.length > 0) {
    matched.push(`agency wording: ${fromTaxonomy.labels.slice(0, 3).join(", ")}`);
  }

  return {
    terms: normalized,
    types: [...types],
    rawCodes: [...rawCodes],
    codeOrder: [...rawCodes].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99)),
    matched: [...new Set(matched)],
  };
}
