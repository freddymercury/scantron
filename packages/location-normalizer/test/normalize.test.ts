import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  compareStreets,
  normalizeLocation,
  normalizeStreetName,
  ordinal,
} from "../src/index.ts";

const canonical = (raw: string) => normalizeLocation(raw).canonical;

test("every written form of one corner produces one string (PRD §16)", () => {
  const forms = [
    "19TH AV/IRVING ST",
    "19th and Irving",
    "IRVING / 19TH",
    "19TH AVE AT IRVING",
    "19th Ave & Irving St",
    "IRVING ST \\ 19TH AVE",
    "irving st / 19th ave",
  ];
  for (const form of forms) {
    expect(`${form} → ${canonical(form)}`).toBe(`${form} → 19th Ave & Irving St`);
  }
});

test("all five separators the feeds use mean the same thing", () => {
  // Police writes `\`, fire writes `/`, humans write `and`.
  for (const form of [
    "MISSION ST \\ 24TH ST",
    "MISSION ST/24TH ST",
    "MISSION ST & 24TH ST",
    "MISSION ST AT 24TH ST",
    "MISSION ST AND 24TH ST",
  ]) {
    expect(canonical(form)).toBe("24th St & Mission St");
  }
});

test("cross-street order carries no meaning", () => {
  expect(canonical("HYDE ST \\ ELLIS ST")).toBe(canonical("ELLIS ST \\ HYDE ST"));
  expect(canonical("ELLIS ST \\ HYDE ST")).toBe("Ellis St & Hyde St");
  // Numbered streets sort numerically, and before names.
  expect(canonical("MISSION ST \\ 03RD ST")).toBe("3rd St & Mission St");
  expect(compareStreets("19th Ave", "3rd Ave")).toBeGreaterThan(0);
  expect(compareStreets("3rd Ave", "Irving St")).toBeLessThan(0);
});

test("suffixes are expanded and ordinals normalized", () => {
  expect(normalizeStreetName("06TH ST")).toBe("6th St");
  expect(normalizeStreetName("23RD AVE")).toBe("23rd Ave");
  expect(normalizeStreetName("MISSION STREET")).toBe("Mission St");
  expect(normalizeStreetName("SLOAT BLVD")).toBe("Sloat Blvd");
  expect(normalizeStreetName("PORTOLA DR")).toBe("Portola Dr");
  expect(normalizeStreetName("BROTHERHOOD WAY")).toBe("Brotherhood Way");
  expect(normalizeStreetName("MINNA ST")).toBe("Minna St");
  expect(normalizeStreetName("SHAW ALY")).toBe("Shaw Aly");
  expect(ordinal(1)).toBe("1st");
  expect(ordinal(11)).toBe("11th");
  expect(ordinal(22)).toBe("22nd");
  expect(ordinal(103)).toBe("103rd");
});

test("SF-specific names resolve, including the ones that changed", () => {
  expect(canonical("ARMY ST \\ MISSION ST")).toBe("Cesar Chavez St & Mission St");
  expect(canonical("CESAR CHAVEZ ST \\ MISSION ST")).toBe("Cesar Chavez St & Mission St");
  expect(normalizeStreetName("OSHAUGHNESSY BLVD")).toBe("O'Shaughnessy Blvd");
  expect(normalizeStreetName("O'SHAUGHNESSY BLVD")).toBe("O'Shaughnessy Blvd");
  expect(normalizeStreetName("THIRD ST")).toBe("3rd St");
  expect(normalizeStreetName("03RD ST")).toBe("3rd St");
  expect(normalizeStreetName("GREAT HWY")).toBe("Great Highway");
  expect(normalizeStreetName("THE EMBARCADERO")).toBe("The Embarcadero");
  expect(normalizeStreetName("MCALLISTER ST")).toBe("McAllister St");
  expect(normalizeStreetName("SOUTH VAN NESS AVE")).toBe("South Van Ness Ave");
  expect(normalizeStreetName("S VAN NESS AVE")).toBe("South Van Ness Ave");
});

test("a bare numbered street is resolved from its partner, not guessed blindly", () => {
  // Irving crosses the numbered avenues; Mission does not.
  expect(canonical("19th and Irving")).toBe("19th Ave & Irving St");
  expect(canonical("19th and Mission")).toBe("19th St & Mission St");
  expect(canonical("25th and Clement")).toBe("25th Ave & Clement St");
  // Alone, with nothing to resolve against, it stays honest.
  expect(normalizeStreetName("19TH")).toBe("19th");
});

test("blocks and addresses are distinguished", () => {
  expect(normalizeLocation("2300 BLOCK OF MISSION ST")).toMatchObject({
    kind: "block",
    canonical: "2300 block of Mission St",
    addressNumber: 2300,
    streets: ["Mission St"],
  });
  expect(normalizeLocation("2300 BLOCK MISSION ST").kind).toBe("block");
  expect(normalizeLocation("1234 MARKET ST")).toMatchObject({
    kind: "address",
    canonical: "1234 Market St",
    addressNumber: 1234,
  });
});

test("call boxes resolve to what they are near, at slightly lower confidence", () => {
  const box = normalizeLocation("CALL BOX: 199 13TH ST,SF");
  expect(box).toMatchObject({ kind: "address", canonical: "199 13th St", addressNumber: 199 });
  expect(box.confidence).toBeLessThan(normalizeLocation("199 13TH ST").confidence);

  expect(normalizeLocation("CALL BOX: ST LUKES HOSPITAL")).toMatchObject({
    kind: "landmark",
    canonical: "St Lukes Hospital",
  });
});

test("multi-way intersections are kept, at lower confidence than a corner", () => {
  const four = normalizeLocation("12TH ST/MISSION ST/OTIS ST/SOUTH VAN NESS AVE");
  expect(four.kind).toBe("intersection");
  expect(four.streets).toHaveLength(4);
  expect(four.confidence).toBeLessThan(normalizeLocation("12TH ST/MISSION ST").confidence);
});

test("unparseable input is never a guess", () => {
  for (const raw of ["Not Available", "UNKNOWN", "", "   ", "N/A", "???", "zzzz"]) {
    const result = normalizeLocation(raw);
    expect(`${raw}: ${result.kind} ${result.confidence}`).toBe(`${raw}: unknown 0`);
    expect(result.canonical).toBe("");
  }
  // The raw string survives normalization, always.
  expect(normalizeLocation("Not Available").raw).toBe("Not Available");
  expect(normalizeLocation(null).kind).toBe("unknown");
  expect(normalizeLocation(undefined).kind).toBe("unknown");
});

test("normalization is idempotent — its own output re-parses unchanged", () => {
  for (const raw of [
    "19TH AV/IRVING ST",
    "ELLIS ST \\ HYDE ST",
    "CESAR CHAVEZ ST \\ SOUTH VAN NESS AVE",
    "1234 MARKET ST",
  ]) {
    const once = canonical(raw);
    expect(`${raw}: ${canonical(once)}`).toBe(`${raw}: ${once}`);
  }
});

/**
 * The regression suite: 230 location strings captured from the live police and fire feeds
 * on 2026-09-18, with the parse they currently produce. This is a snapshot, not a
 * hand-derived oracle — its job is to make any change in behaviour visible in a diff.
 * A new parse bug adds a case here (S-C1).
 */
interface Expected {
  raw: string;
  kind: string;
  canonical: string;
  streets: string[];
  addressNumber?: number;
}

const EXPECTED = JSON.parse(
  readFileSync(new URL("./fixtures/observed-locations.expected.json", import.meta.url).pathname, "utf8"),
) as Expected[];

test("the observed-location suite has at least 200 real cases", () => {
  expect(EXPECTED.length).toBeGreaterThanOrEqual(200);
});

test("every observed location parses as recorded", () => {
  const drift: string[] = [];
  for (const expected of EXPECTED) {
    const actual = normalizeLocation(expected.raw);
    if (actual.kind !== expected.kind || actual.canonical !== expected.canonical) {
      drift.push(`${expected.raw}: ${expected.kind}/${expected.canonical} → ${actual.kind}/${actual.canonical}`);
    }
  }
  expect(drift).toEqual([]);
});

test("almost every real string is understood — coverage is the point", () => {
  const unknown = EXPECTED.filter((expected) => expected.kind === "unknown");
  // The one that is not understood is the feed's own "Not Available" sentinel.
  expect(unknown.map((expected) => expected.raw)).toEqual(["Not Available"]);
  const intersections = EXPECTED.filter((expected) => expected.kind === "intersection");
  expect(intersections.length / EXPECTED.length).toBeGreaterThan(0.95);
});
