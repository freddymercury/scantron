import { expect, test } from "bun:test";
import { canonicalUnit, parseUnit, scrubPersonIdentifiers, UNIT_CLASSES } from "../src/index.ts";

test("every unit format the live SFFD feed uses parses", () => {
  // Prefixes and counts observed in 1,000 rows on 2026-09-18.
  const cases: [string, string, string][] = [
    ["E07", "engine", "fire"],
    ["T07", "truck", "fire"],
    ["B02", "battalion", "fire"],
    ["M18", "medic", "ems"],
    ["AM104", "ambulance", "ems"],
    ["KM12", "ambulance", "ems"],
    ["SCRT8", "medic", "ems"],
    ["RC3", "rescue", "ems"],
    ["RS1", "rescue", "fire"],
    ["QRV2", "medic", "ems"],
    ["CP12", "command", "fire"],
    ["EMS6B", "command", "ems"],
    ["RB1", "rescue", "fire"],
    ["VAN1", "support", "fire"],
    ["RWC1", "support", "fire"],
  ];
  for (const [raw, unitClass, agency] of cases) {
    const parsed = parseUnit(raw);
    expect(`${raw}: ${parsed.unitClass}/${parsed.agency}`).toBe(`${raw}: ${unitClass}/${agency}`);
  }
});

test("canonical form is what correlation compares", () => {
  expect(canonicalUnit("Medic 18")).toBe("MEDIC18");
  expect(canonicalUnit("e07")).toBe("E07");
  expect(canonicalUnit("E-07")).toBe("E07");
  // Zero padding is the city's, and is kept: E07 and E7 are written differently but the
  // feed is internally consistent, so we do not invent a normalization it does not use.
  expect(canonicalUnit("E07")).toBe("E07");
});

test("an SFPD radio car parses as patrol", () => {
  const parsed = parseUnit("3A12");
  expect(parsed).toMatchObject({ agency: "police", unitClass: "patrol", number: 12 });
});

test("the feed's own unit_type beats guessing from the prefix", () => {
  expect(parseUnit("CP5", { unitType: "CHIEF" })).toMatchObject({ unitClass: "battalion" });
  expect(parseUnit("CP5").unitClass).toBe("command");
});

test("an unrecognized unit is kept, not discarded", () => {
  const parsed = parseUnit("ZQ9");
  expect(parsed.designator).toBe("ZQ9");
  expect(parsed.unitClass).toBe("unknown");
  expect(parsed.agency).toBe("other");
  expect([...UNIT_CLASSES]).toContain(parsed.unitClass);
});

test("person-identifying fields are dropped, apparatus is kept", () => {
  const { value, dropped } = scrubPersonIdentifiers({
    call_number: "262592589",
    unit_id: "M567",
    officer_name: "A Person",
    badge_number: "1234",
    caller_phone: "+1-415-555-0100",
    rp_name: "Another Person",
    unit_type: "MEDIC",
  });

  expect(Object.keys(value).sort()).toEqual(["call_number", "unit_id", "unit_type"]);
  expect(dropped.sort()).toEqual(["badge_number", "caller_phone", "officer_name", "rp_name"]);
  // Units are apparatus, not people: they stay.
  expect(value.unit_id).toBe("M567");
});
