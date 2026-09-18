/**
 * San Francisco street data, as data (S-C1). Adding a street or an alias must never mean
 * editing the parser.
 */

/** Abbreviation → canonical suffix, as the city writes it. */
export const STREET_SUFFIXES: Readonly<Record<string, string>> = {
  ST: "St",
  STREET: "St",
  AVE: "Ave",
  AV: "Ave",
  AVENUE: "Ave",
  BLVD: "Blvd",
  BOULEVARD: "Blvd",
  DR: "Dr",
  DRIVE: "Dr",
  RD: "Rd",
  ROAD: "Rd",
  WAY: "Way",
  WY: "Way",
  LN: "Ln",
  LANE: "Ln",
  CT: "Ct",
  COURT: "Ct",
  PL: "Pl",
  PLACE: "Pl",
  TER: "Ter",
  TERR: "Ter",
  TERRACE: "Ter",
  ALY: "Aly",
  ALLEY: "Aly",
  HWY: "Hwy",
  HIGHWAY: "Hwy",
  CIR: "Cir",
  CIRCLE: "Cir",
  PLZ: "Plz",
  PLAZA: "Plz",
  PARK: "Park",
  PK: "Park",
  EXPY: "Expy",
  EXPRESSWAY: "Expy",
  STPS: "Stps",
  STEPS: "Stps",
  WALK: "Walk",
  ROW: "Row",
  PATH: "Path",
  BRG: "Brg",
  TUNL: "Tunl",
};

export const DIRECTIONS: Readonly<Record<string, string>> = {
  N: "North",
  S: "South",
  E: "East",
  W: "West",
  NORTH: "North",
  SOUTH: "South",
  EAST: "East",
  WEST: "West",
};

/**
 * Written forms that mean the same street. Keys are upper-case, punctuation-free; values
 * are the canonical rendering. Renamings live here too — Army St became Cesar Chavez St in
 * 1995 and still appears in older records.
 */
export const STREET_ALIASES: Readonly<Record<string, string>> = {
  "ARMY ST": "Cesar Chavez St",
  ARMY: "Cesar Chavez St",
  "CESAR CHAVEZ": "Cesar Chavez St",
  "CHAVEZ ST": "Cesar Chavez St",
  "THIRD ST": "3rd St",
  "THIRD STREET": "3rd St",
  "FIRST ST": "1st St",
  "SECOND ST": "2nd St",
  "FOURTH ST": "4th St",
  "FIFTH ST": "5th St",
  "SIXTH ST": "6th St",
  "SEVENTH ST": "7th St",
  "EIGHTH ST": "8th St",
  "NINTH ST": "9th St",
  "TENTH ST": "10th St",
  "GREAT HWY": "Great Highway",
  "GREAT HIGHWAY": "Great Highway",
  "THE GREAT HIGHWAY": "Great Highway",
  EMBARCADERO: "The Embarcadero",
  "THE EMBARCADERO": "The Embarcadero",
  "EMBARCADERO ST": "The Embarcadero",
  "OSHAUGHNESSY BLVD": "O'Shaughnessy Blvd",
  "O SHAUGHNESSY BLVD": "O'Shaughnessy Blvd",
  "BROTHERHOOD WAY": "Brotherhood Way",
  "PORTOLA DR": "Portola Dr",
  "JOHN F KENNEDY DR": "John F Kennedy Dr",
  "JFK DR": "John F Kennedy Dr",
  "MLK JR DR": "Martin Luther King Jr Dr",
  "MARTIN LUTHER KING JR DR": "Martin Luther King Jr Dr",
  "SOUTH VAN NESS AVE": "South Van Ness Ave",
  "VAN NESS AVE": "Van Ness Ave",
  "BAYSHORE BLVD": "Bayshore Blvd",
  "GOLDEN GATE AVE": "Golden Gate Ave",
  "SAN JOSE AVE": "San Jose Ave",
  "19TH AVE": "19th Ave",
  "PANHANDLE": "The Panhandle",
};

/**
 * Words whose casing is not simply title case. Keyed by the upper-case form, because the
 * city writes everything upper-case.
 */
export const CASING_EXCEPTIONS: Readonly<Record<string, string>> = {
  MCALLISTER: "McAllister",
  MCCOPPIN: "McCoppin",
  MCLAREN: "McLaren",
  OSHAUGHNESSY: "O'Shaughnessy",
  "O'SHAUGHNESSY": "O'Shaughnessy",
  OFARRELL: "O'Farrell",
  "O'FARRELL": "O'Farrell",
  "O'REILLY": "O'Reilly",
  DEHARO: "De Haro",
  DE: "de",
  LA: "la",
  JR: "Jr",
  II: "II",
  III: "III",
  JFK: "JFK",
  MLK: "MLK",
  US: "US",
  SF: "SF",
};

/** Values that mean "we do not know", not a location. The feeds really do contain these. */
export const LOCATION_SENTINELS: readonly string[] = [
  "NOT AVAILABLE",
  "UNKNOWN",
  "N/A",
  "NA",
  "NONE",
  "NO LOCATION",
  "UNK",
  "TBD",
];

/** Spelled-out ordinals, which appear alongside the numeric forms. */
export const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  FIRST: 1,
  SECOND: 2,
  THIRD: 3,
  FOURTH: 4,
  FIFTH: 5,
  SIXTH: 6,
  SEVENTH: 7,
  EIGHTH: 8,
  NINTH: 9,
  TENTH: 10,
  ELEVENTH: 11,
  TWELFTH: 12,
  THIRTEENTH: 13,
  FOURTEENTH: 14,
  FIFTEENTH: 15,
  SIXTEENTH: 16,
  SEVENTEENTH: 17,
  EIGHTEENTH: 18,
  NINETEENTH: 19,
  TWENTIETH: 20,
};

/** Landmarks the feeds name directly, usually behind a `CALL BOX:` prefix. */
export const LANDMARK_HINTS: readonly string[] = [
  "HOSPITAL",
  "THEATER",
  "THEATRE",
  "STATION",
  "TERMINAL",
  "AIRPORT",
  "PLAZA",
  "PARK",
  "CENTER",
  "CENTRE",
  "SCHOOL",
  "COLLEGE",
  "UNIVERSITY",
  "PIER",
  "STADIUM",
  "LIBRARY",
  "BLDG",
  "TOWER",
];
