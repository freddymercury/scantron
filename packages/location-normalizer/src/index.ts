/**
 * @scantron/location-normalizer — the many written forms of an SF location, parsed into
 * one canonical structure (S-C1, PRD §16).
 *
 * This is the domain asset (PRD §57): two agencies describing the same corner must produce
 * the same string, or correlation has nothing to match on. The police feed writes
 * `23RD AVE \ IRVING ST`, the fire feed writes `LYON ST/UNION ST`, and a human writes
 * `19th and Irving` — all three are the same shape of fact.
 *
 * The rule that keeps it honest: **unparseable input is `unknown` with confidence 0 and
 * the raw string preserved. Never a guess.**
 */

import {
  AMBIGUOUS_STREET_NAMES,
  AVENUE_CROSS_STREETS,
  CASING_EXCEPTIONS,
  DIRECTIONS,
  LANDMARK_HINTS,
  LOCATION_SENTINELS,
  ORDINAL_WORDS,
  SF_STREET_SUFFIXES,
  STREET_ALIASES,
  STREET_SUFFIXES,
} from "@scantron/sf-domain";

const AMBIGUOUS = new Set(AMBIGUOUS_STREET_NAMES.map((name) => name.toUpperCase()));
const CROSSES_AVENUE = new Set(AVENUE_CROSS_STREETS.map((name) => name.toUpperCase()));

export type LocationKind = "intersection" | "address" | "block" | "landmark" | "unknown";

export interface NormalizedLocationText {
  kind: LocationKind;
  /** The canonical rendering; equal strings mean the same place. */
  canonical: string;
  streets: string[];
  addressNumber?: number;
  confidence: number;
  /** Always kept, so nothing is lost by normalizing. */
  raw: string;
}

/** `\`, `/`, `&`, ` AT `, ` AND `, ` X ` all mean "these streets cross". */
const SEPARATORS = /\s*(?:\\|\/|&|\bAT\b|\bAND\b|\bX\b)\s*/g;
const BLOCK = /^(\d+)\s+BLOCK\s+(?:OF\s+)?(.+)$/;
const ADDRESS = /^(\d+)\s+(.+)$/;
const CALL_BOX = /^(?:CALL\s*BOX|CB)\s*[:#-]?\s*(.+)$/;
const ORDINAL_NUMBER = /^0*(\d+)(?:ST|ND|RD|TH)$/;

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  const last = n % 10;
  return last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
}

export function ordinal(n: number): string {
  return `${n}${ordinalSuffix(n)}`;
}

function titleCaseWord(word: string): string {
  const upper = word.toUpperCase();
  const exception = CASING_EXCEPTIONS[upper];
  if (exception) return exception;
  if (upper.includes("'")) {
    // O'Brien, not O'brien.
    return upper
      .split("'")
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join("'");
  }
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/**
 * One street name → its canonical form: ordinals numeric, suffix expanded, directionals
 * spelled out, aliases resolved.
 */
export interface StreetContext {
  /** The other streets in the same expression, used to resolve an ambiguous name. */
  partners?: readonly string[];
}

/**
 * Complete a street written without a suffix, using the city's own usage
 * (`SF_STREET_SUFFIXES`, derived from every historical intersection string).
 *
 * `19th` is genuinely ambiguous — San Francisco has both `19th St` and `19th Ave` — so it
 * is resolved from context: if a partner street is one of the named streets that cross the
 * numbered avenues, the answer is `Ave`. With no usable context the name is left bare
 * rather than guessed.
 */
function inferSuffix(base: string, context: StreetContext = {}): string | undefined {
  const key = base.toUpperCase();
  if (!AMBIGUOUS.has(key)) return SF_STREET_SUFFIXES[key];

  const isNumbered = /^\d+(?:st|nd|rd|th)$/i.test(base);
  if (!isNumbered) return undefined;

  const partners = (context.partners ?? []).map((partner) => partner.toUpperCase());
  if (partners.length === 0) return undefined;

  const crossesAvenue = partners.some((partner) => {
    const withoutSuffix = partner.split(" ").slice(0, -1).join(" ") || partner;
    return CROSSES_AVENUE.has(partner) || CROSSES_AVENUE.has(withoutSuffix);
  });
  // With a partner that crosses the avenues, this is the Richmond/Sunset grid. Otherwise
  // it is the eastern grid, where numbered streets are `St` — also the commoner form in
  // the records (e.g. 19th St appears 53 times to 19th Ave's 36). The alternative is to
  // leave it bare, which would make `19th and Mission` and the feed's `19TH ST \ MISSION
  // ST` two different strings for one corner, and correlation would never match them.
  return crossesAvenue ? "Ave" : "St";
}

export function normalizeStreetName(input: string, context: StreetContext = {}): string | undefined {
  const cleaned = input
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (!cleaned) return undefined;

  const aliasDirect = STREET_ALIASES[cleaned];
  if (aliasDirect) return aliasDirect;

  const words = cleaned.split(" ");
  const out: string[] = [];

  words.forEach((word, index) => {
    const isLast = index === words.length - 1;
    const isFirst = index === 0;

    const ordinalMatch = ORDINAL_NUMBER.exec(word);
    if (ordinalMatch) {
      out.push(ordinal(Number(ordinalMatch[1])));
      return;
    }
    const spelled = ORDINAL_WORDS[word];
    if (spelled !== undefined && !isLast) {
      out.push(ordinal(spelled));
      return;
    }
    if (isLast && STREET_SUFFIXES[word] && out.length > 0) {
      out.push(STREET_SUFFIXES[word] as string);
      return;
    }
    if (isFirst && DIRECTIONS[word] && words.length > 1) {
      out.push(DIRECTIONS[word] as string);
      return;
    }
    out.push(titleCaseWord(word));
  });

  let canonical = out.join(" ");

  // No suffix written? The city's own usage usually knows which one belongs.
  const lastWord = (words.at(-1) as string).toUpperCase();
  if (!STREET_SUFFIXES[lastWord]) {
    const suffix = inferSuffix(canonical, context);
    if (suffix) canonical = `${canonical} ${suffix}`;
  }

  // Aliases are checked again on the canonical form, so `ARMY` and `Army St` both land.
  return STREET_ALIASES[canonical.toUpperCase()] ?? canonical;
}

/**
 * Cross streets are sorted so that order carries no meaning: `19TH AV/IRVING ST` and
 * `IRVING / 19TH` produce the same canonical string. Numbered avenues sort numerically
 * before names, which is what a reader expects of `19th Ave & Irving St`.
 */
export function compareStreets(a: string, b: string): number {
  const numberOf = (street: string): number | undefined => {
    const match = /^(\d+)(?:st|nd|rd|th)\b/.exec(street);
    return match ? Number(match[1]) : undefined;
  };
  const aNumber = numberOf(a);
  const bNumber = numberOf(b);
  if (aNumber !== undefined && bNumber !== undefined) return aNumber - bNumber;
  if (aNumber !== undefined) return -1;
  if (bNumber !== undefined) return 1;
  return a.localeCompare(b);
}

function unknown(raw: string): NormalizedLocationText {
  return { kind: "unknown", canonical: "", streets: [], confidence: 0, raw };
}

function looksLikeLandmark(text: string): boolean {
  const upper = text.toUpperCase();
  return LANDMARK_HINTS.some((hint) => upper.includes(hint));
}

/**
 * Parse a raw location string. `confidence` reflects how much of the string was
 * understood, not how precise the place is.
 */
export function normalizeLocation(raw: string | null | undefined): NormalizedLocationText {
  if (raw === null || raw === undefined) return unknown("");
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return unknown(raw);
  if (LOCATION_SENTINELS.includes(trimmed.toUpperCase())) return unknown(trimmed);

  // `CALL BOX: 199 13TH ST,SF` — the box is not the place; what follows it is.
  const callBox = CALL_BOX.exec(trimmed.toUpperCase());
  if (callBox) {
    const inner = (callBox[1] as string).replace(/,\s*SF$/i, "").trim();
    const parsed = normalizeLocation(inner);
    if (parsed.kind !== "unknown") {
      // Slightly lower confidence: a call box is near the address, not at it.
      return { ...parsed, raw: trimmed, confidence: Math.max(0, parsed.confidence - 0.1) };
    }
    return {
      kind: "landmark",
      canonical: titleCase(inner),
      streets: [],
      confidence: 0.4,
      raw: trimmed,
    };
  }

  const parts = trimmed
    .toUpperCase()
    .split(SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    // Two passes: the first gets whatever is unambiguous, the second uses those results as
    // context for the names that need it (`19th and Irving`).
    const firstPass = parts.map((part) => normalizeStreetName(part) ?? part);
    const streets = parts
      .map((part, index) =>
        normalizeStreetName(part, {
          partners: firstPass.filter((_, other) => other !== index),
        }),
      )
      .filter((street): street is string => Boolean(street));
    if (streets.length >= 2) {
      const unique = [...new Set(streets)].sort(compareStreets);
      return {
        kind: "intersection",
        canonical: unique.join(" & "),
        streets: unique,
        // Multi-way intersections (the fire feed has 3- and 4-street forms) are real, but
        // name a wider area than a simple corner.
        confidence: unique.length === 2 ? 0.95 : 0.8,
        raw: trimmed,
      };
    }
    return unknown(trimmed);
  }

  const single = parts[0] as string;

  const block = BLOCK.exec(single);
  if (block) {
    const street = normalizeStreetName(block[2] as string);
    if (!street) return unknown(trimmed);
    return {
      kind: "block",
      canonical: `${block[1]} block of ${street}`,
      streets: [street],
      addressNumber: Number(block[1]),
      confidence: 0.9,
      raw: trimmed,
    };
  }

  const address = ADDRESS.exec(single);
  if (address) {
    const street = normalizeStreetName(address[2] as string);
    if (!street) return unknown(trimmed);
    return {
      kind: "address",
      canonical: `${Number(address[1])} ${street}`,
      streets: [street],
      addressNumber: Number(address[1]),
      confidence: 0.9,
      raw: trimmed,
    };
  }

  if (looksLikeLandmark(single)) {
    return {
      kind: "landmark",
      canonical: titleCase(single),
      streets: [],
      confidence: 0.5,
      raw: trimmed,
    };
  }

  const street = normalizeStreetName(single);
  if (street && /\s/.test(street)) {
    // A street with no number locates a street, not a point — hence the low confidence.
    return { kind: "block", canonical: street, streets: [street], confidence: 0.4, raw: trimmed };
  }

  return unknown(trimmed);
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => titleCaseWord(word))
    .join(" ");
}
