/**
 * Responding units (S-C4).
 *
 * Unit identifiers name *apparatus*, not people — `E07` is an engine, not a firefighter —
 * which is why they are safe to publish while officer names and badge numbers are not.
 * Prefixes below are the ones the live SFFD feed actually uses (168 distinct units in a
 * 1,000-row sample on 2026-09-18).
 */

export const UNIT_CLASSES = [
  "engine",
  "truck",
  "battalion",
  "medic",
  "ambulance",
  "rescue",
  "patrol",
  "command",
  "support",
  "unknown",
] as const;
export type UnitClass = (typeof UNIT_CLASSES)[number];

export type UnitAgency = "police" | "fire" | "ems" | "other";

export interface ParsedUnit {
  /** Exactly as the source wrote it, always kept. */
  raw: string;
  /** Canonical form: upper-case, no spaces or punctuation. */
  designator: string;
  agency: UnitAgency;
  unitClass: UnitClass;
  /** The numeric part, when there is one: `E07` → 7. */
  number?: number;
}

/** Prefix → what it is. Order matters: longer prefixes are tested first. */
export const UNIT_PREFIXES: readonly { prefix: string; unitClass: UnitClass; agency: UnitAgency }[] =
  [
    { prefix: "MEDIC", unitClass: "medic", agency: "ems" },
    { prefix: "ENGINE", unitClass: "engine", agency: "fire" },
    { prefix: "TRUCK", unitClass: "truck", agency: "fire" },
    { prefix: "SCRT", unitClass: "medic", agency: "ems" }, // street crisis response team
    { prefix: "QRV", unitClass: "medic", agency: "ems" }, // quick response vehicle
    { prefix: "EMS", unitClass: "command", agency: "ems" },
    { prefix: "RWC", unitClass: "support", agency: "fire" },
    { prefix: "VAN", unitClass: "support", agency: "fire" },
    { prefix: "RC", unitClass: "rescue", agency: "ems" }, // rescue captain
    { prefix: "RS", unitClass: "rescue", agency: "fire" }, // rescue squad
    { prefix: "RB", unitClass: "rescue", agency: "fire" },
    { prefix: "CP", unitClass: "command", agency: "fire" },
    { prefix: "AM", unitClass: "ambulance", agency: "ems" }, // private ambulance
    { prefix: "KM", unitClass: "ambulance", agency: "ems" },
    { prefix: "BLS", unitClass: "ambulance", agency: "ems" },
    { prefix: "M", unitClass: "medic", agency: "ems" },
    { prefix: "E", unitClass: "engine", agency: "fire" },
    { prefix: "T", unitClass: "truck", agency: "fire" },
    { prefix: "B", unitClass: "battalion", agency: "fire" },
    { prefix: "D", unitClass: "command", agency: "fire" },
  ];

/** SFFD `unit_type`, when the feed supplies it, beats guessing from the prefix. */
export const UNIT_TYPE_CLASSES: Readonly<Record<string, { unitClass: UnitClass; agency: UnitAgency }>> =
  {
    ENGINE: { unitClass: "engine", agency: "fire" },
    TRUCK: { unitClass: "truck", agency: "fire" },
    CHIEF: { unitClass: "battalion", agency: "fire" },
    MEDIC: { unitClass: "medic", agency: "ems" },
    PRIVATE: { unitClass: "ambulance", agency: "ems" },
    BLS: { unitClass: "ambulance", agency: "ems" },
    "RESCUE CAPTAIN": { unitClass: "rescue", agency: "ems" },
    "RESCUE SQUAD": { unitClass: "rescue", agency: "fire" },
    SUPPORT: { unitClass: "support", agency: "fire" },
    CP: { unitClass: "command", agency: "fire" },
    INVESTIGATION: { unitClass: "support", agency: "fire" },
  };

/** SFPD radio car: district digit, sector letter, car number — `3A12`. */
const POLICE_CAR = /^(\d)([A-Z])(\d{1,2})$/;
const SPLIT = /^([A-Z]+)\s*0*(\d+)([A-Z]?)$/;

export interface ParseUnitHints {
  /** The feed's own `unit_type`, if it has one. */
  unitType?: string | undefined;
  source?: string | undefined;
}

/**
 * Parse one unit string. An unrecognized string is kept raw with `unknown` class rather
 * than discarded — a unit we cannot classify is still a unit that responded.
 */
export function parseUnit(raw: string, hints: ParseUnitHints = {}): ParsedUnit {
  const designator = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parsed: ParsedUnit = { raw, designator, agency: "other", unitClass: "unknown" };
  if (!designator) return parsed;

  const police = POLICE_CAR.exec(designator);
  if (police && hints.source !== "sf_fire_cad" && hints.source !== "sf_ems_cad") {
    parsed.agency = "police";
    parsed.unitClass = "patrol";
    parsed.number = Number(police[3]);
    return parsed;
  }

  const split = SPLIT.exec(designator);
  if (split) parsed.number = Number(split[2]);

  const fromType = hints.unitType
    ? UNIT_TYPE_CLASSES[hints.unitType.trim().toUpperCase()]
    : undefined;
  if (fromType) {
    parsed.unitClass = fromType.unitClass;
    parsed.agency = fromType.agency;
    return parsed;
  }

  const letters = split?.[1] ?? designator;
  for (const candidate of UNIT_PREFIXES) {
    if (letters === candidate.prefix) {
      parsed.unitClass = candidate.unitClass;
      parsed.agency = candidate.agency;
      return parsed;
    }
  }
  return parsed;
}

/** Canonical designator only — the form correlation compares. */
export function canonicalUnit(raw: string): string {
  return parseUnit(raw).designator;
}

/**
 * Fields that name a *person* rather than a piece of apparatus. Dropped at the adapter,
 * never stored, even if a feed starts publishing them (S-C4).
 */
export const PERSON_IDENTIFYING_FIELDS = [
  "officer",
  "officer_name",
  "badge",
  "badge_number",
  "star",
  "star_number",
  "employee",
  "employee_id",
  "responder_name",
  "caller_name",
  "caller_phone",
  "rp_name",
  "victim",
  "suspect_name",
] as const;

/**
 * Deliberately specific rather than clever. An earlier version matched any `*_name` field
 * and silently ate `intersection_name` — a location, not a person. A scrubber that removes
 * the wrong fields is worse than one that removes few: it destroys data while looking safe.
 */
const PERSON_PATTERN =
  /(officer|badge|star_number|employee|responder|caller|complainant|reporting_party|^rp_|victim|suspect|person_name|first_name|last_name|full_name|phone|email|ssn|\bdob\b|date_of_birth|driver_license)/i;

export interface ScrubResult<T> {
  value: T;
  /** Names of the fields removed, for the counter S-C4 asks for. */
  dropped: string[];
}

/** Remove person-identifying fields from a source payload before it is stored. */
export function scrubPersonIdentifiers(
  record: Record<string, unknown>,
): ScrubResult<Record<string, unknown>> {
  const value: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, field] of Object.entries(record)) {
    if (PERSON_PATTERN.test(key)) dropped.push(key);
    else value[key] = field;
  }
  return { value, dropped };
}
