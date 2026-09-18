/**
 * The grammar behind the ask box (S-H4, Tier 1).
 *
 * Deterministic on purpose: it is testable, instant, free, and it keeps working when
 * nothing else does. The parser chooses a *query*; it never writes the answer — every
 * sentence a reader sees comes from a template over structured data (PRD §21).
 */

import { INCIDENT_TYPES, type IncidentType } from "@scantron/incident-schema";

export interface CategoryRule {
  /** Phrases a person actually types, longest matched first. */
  phrases: readonly string[];
  types?: readonly IncidentType[];
  /** Agency codes, when they are more precise than the type — a car break-in is 852. */
  rawCodes?: readonly string[];
  /** How the interpretation is echoed back: "car break-ins". */
  label: string;
}

export const CATEGORIES: readonly CategoryRule[] = [
  {
    phrases: ["car break in", "car break-in", "car breakins", "break into cars", "auto boost", "car burglary", "smash and grab", "smash-and-grab"],
    rawCodes: ["852"],
    types: ["theft"],
    label: "car break-ins",
  },
  {
    phrases: ["stolen car", "stolen vehicle", "car theft", "auto theft"],
    rawCodes: ["851", "853"],
    types: ["theft"],
    label: "vehicle thefts",
  },
  {
    phrases: ["shooting", "shots fired", "gunfire", "gun", "shotspotter"],
    rawCodes: ["216", "216S", "221"],
    types: ["weapon"],
    label: "shootings and weapon calls",
  },
  { phrases: ["stabbing", "knife"], rawCodes: ["219", "222"], types: ["assault"], label: "stabbings" },
  { phrases: ["robbery", "robberies", "holdup", "mugging"], types: ["robbery"], label: "robberies" },
  { phrases: ["burglary", "burglaries", "break in", "break-in", "prowler"], types: ["burglary"], label: "burglaries" },
  { phrases: ["theft", "thefts", "stealing", "shoplifting"], types: ["theft"], label: "thefts" },
  { phrases: ["assault", "assaults", "fight", "fights", "battery"], types: ["assault"], label: "assaults" },
  { phrases: ["fire", "fires", "smoke", "structure fire"], types: ["fire"], label: "fires" },
  { phrases: ["medical", "medical call", "ambulance", "overdose", "od", "ems"], types: ["medical"], label: "medical calls" },
  { phrases: ["crash", "crashes", "collision", "collisions", "accident", "accidents", "hit and run"], types: ["collision"], label: "collisions" },
  { phrases: ["traffic", "traffic stop", "traffic stops"], types: ["traffic"], label: "traffic calls" },
  { phrases: ["police activity", "police"], types: ["police_activity"], label: "police activity" },
  { phrases: ["noise", "noise complaint", "party", "disturbance", "disturbances"], types: ["disturbance"], label: "disturbances" },
  { phrases: ["missing person", "missing people", "missing kid", "missing child"], types: ["missing_person"], label: "missing person reports" },
  { phrases: ["hazard", "gas leak", "hazmat", "spill"], types: ["hazard"], label: "hazards" },
  { phrases: ["rescue", "water rescue", "extrication"], types: ["rescue"], label: "rescues" },
  { phrases: ["protest", "demo", "demonstration"], rawCodes: ["400"], types: ["public_safety"], label: "protests" },
  { phrases: ["mental health", "welfare check", "well being check", "5150"], rawCodes: ["800", "801", "910"], types: ["medical", "public_safety"], label: "welfare and mental-health calls" },
  { phrases: ["homeless", "encampment"], rawCodes: ["915", "919"], types: ["public_safety"], label: "homelessness-related calls" },
];

/** Neighborhood aliases people use, mapped to the city's Analysis Neighborhood names. */
export const AREA_ALIASES: Readonly<Record<string, string>> = {
  soma: "South of Market",
  "south of market": "South of Market",
  "the mission": "Mission",
  mission: "Mission",
  "mission district": "Mission",
  tl: "Tenderloin",
  "the tenderloin": "Tenderloin",
  tenderloin: "Tenderloin",
  "the sunset": "Sunset/Parkside",
  sunset: "Sunset/Parkside",
  "outer sunset": "Sunset/Parkside",
  "inner sunset": "Inner Sunset",
  parkside: "Sunset/Parkside",
  "the richmond": "Outer Richmond",
  "outer richmond": "Outer Richmond",
  "inner richmond": "Inner Richmond",
  "the castro": "Castro/Upper Market",
  castro: "Castro/Upper Market",
  "upper market": "Castro/Upper Market",
  "the haight": "Haight Ashbury",
  haight: "Haight Ashbury",
  "hayes valley": "Hayes Valley",
  "nob hill": "Nob Hill",
  "russian hill": "Russian Hill",
  "north beach": "North Beach",
  chinatown: "Chinatown",
  fidi: "Financial District",
  "financial district": "Financial District",
  downtown: "Financial District",
  "the bayview": "Bayview Hunters Point",
  bayview: "Bayview Hunters Point",
  "hunters point": "Bayview Hunters Point",
  "potrero hill": "Potrero Hill",
  potrero: "Potrero Hill",
  "noe valley": "Noe Valley",
  "bernal heights": "Bernal Heights",
  bernal: "Bernal Heights",
  "glen park": "Glen Park",
  excelsior: "Excelsior",
  "visitacion valley": "Visitacion Valley",
  "viz valley": "Visitacion Valley",
  portola: "Portola",
  "outer mission": "Outer Mission",
  "west portal": "West of Twin Peaks",
  "twin peaks": "Twin Peaks",
  "pacific heights": "Pacific Heights",
  "pac heights": "Pacific Heights",
  marina: "Marina",
  "the marina": "Marina",
  presidio: "Presidio",
  japantown: "Japantown",
  "western addition": "Western Addition",
  "mission bay": "Mission Bay",
  "treasure island": "Treasure Island",
  "golden gate park": "Golden Gate Park",
  "ggp": "Golden Gate Park",
  "lower haight": "Hayes Valley",
  "the excelsior": "Excelsior",
  "the portola": "Portola",
  omi: "Oceanview/Merced/Ingleside",
  ingleside: "Oceanview/Merced/Ingleside",
  lakeshore: "Lakeshore",
  seacliff: "Seacliff",
  "lone mountain": "Lone Mountain/USF",
  usf: "Lone Mountain/USF",
  "mclaren park": "McLaren Park",
  "lincoln park": "Lincoln Park",
  "presidio heights": "Presidio Heights",
};

export interface TimePhrase {
  pattern: RegExp;
  minutes: number;
  label: string;
}

/** Fixed phrases. Numeric ones ("last 90 minutes") are parsed separately. */
export const TIME_PHRASES: readonly TimePhrase[] = [
  { pattern: /\b(right now|now|currently|at the moment)\b/, minutes: 60, label: "the last hour" },
  { pattern: /\b(last night|overnight|tonight)\b/, minutes: 12 * 60, label: "the last 12 hours" },
  { pattern: /\b(today|so far today|this morning|this afternoon)\b/, minutes: 24 * 60, label: "the last 24 hours" },
  { pattern: /\b(this week|past week|last week)\b/, minutes: 7 * 24 * 60, label: "the last week" },
  { pattern: /\b(this month|past month|last month)\b/, minutes: 30 * 24 * 60, label: "the last month" },
  { pattern: /\b(this year|past year|last year)\b/, minutes: 365 * 24 * 60, label: "the last year" },
  { pattern: /\b(all time|ever|everything)\b/, minutes: 0, label: "all the data we have" },
];

export const UNIT_MINUTES: Readonly<Record<string, number>> = {
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  m: 1,
  hour: 60,
  hours: 60,
  hr: 60,
  hrs: 60,
  h: 60,
  day: 24 * 60,
  days: 24 * 60,
  d: 24 * 60,
  week: 7 * 24 * 60,
  weeks: 7 * 24 * 60,
  wk: 7 * 24 * 60,
  month: 30 * 24 * 60,
  months: 30 * 24 * 60,
  year: 365 * 24 * 60,
  years: 365 * 24 * 60,
};

/**
 * Questions this data cannot answer. Detected explicitly and answered honestly, because
 * the failure mode that matters is a confident answer about harm, arrest or safety built
 * out of dispatch codes.
 */
export const UNANSWERABLE: readonly { pattern: RegExp; because: string }[] = [
  {
    pattern: /\b(safe|safety|dangerous|danger|should i|is it ok|walk home|risky)\b/,
    because:
      "this is a feed of dispatch activity, not a safety assessment, and dispatch volume is not danger",
  },
  {
    pattern: /\b(hurt|injured|injuries|killed|died|dead|fatal|condition)\b/,
    because: "dispatch records say what was reported and who responded, never what happened to anyone",
  },
  {
    pattern: /\b(arrested|arrest|charged|convicted|suspect name|who did|who was)\b/,
    because: "outcomes and identities are not in this data, and we do not publish anything about people",
  },
  {
    pattern: /\b(why|cause|caused|what happened)\b/,
    because: "a dispatch record is a report, not an explanation — it carries no narrative",
  },
];

export const ALL_TYPES: readonly string[] = INCIDENT_TYPES;
