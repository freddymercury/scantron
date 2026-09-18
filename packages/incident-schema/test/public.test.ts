/**
 * The leak tests. These are the reason the package exists.
 */

import { expect, test } from "bun:test";
import {
  IncidentSchema,
  PublicIncidentSchema,
  parse,
  toPublicIncident,
  type Incident,
} from "../src/index.ts";
import { anIncident } from "./fixtures.ts";

test("a hostile incident leaks nothing into the public payload", () => {
  const hostile = {
    ...anIncident(),
    ssn: "123-45-6789",
    officer_name: "Officer Fictional",
    sensitive_call: true,
    reporterPhone: "+1-415-555-0100",
  } as unknown as Incident;

  const serialized = JSON.stringify(toPublicIncident(hostile));

  expect(serialized).not.toContain("ssn");
  expect(serialized).not.toContain("123-45-6789");
  expect(serialized).not.toContain("officer_name");
  expect(serialized).not.toContain("Officer Fictional");
  expect(serialized).not.toContain("sensitive_call");
  expect(serialized).not.toContain("reporterPhone");
  expect(serialized).not.toContain("555-0100");
});

test("internal fields never appear, even when set", () => {
  const incident = anIncident({
    visibility: "restricted",
    confidence: 0.72,
    confidences: { location: 0.9, type: 0.7, correlation: 0.6, status: 0.8 },
    mergedIntoId: "inc_9",
  });
  const publicIncident = toPublicIncident(incident);
  const keys = Object.keys(publicIncident);

  expect(keys).not.toContain("confidence");
  expect(keys).not.toContain("confidences");
  expect(keys).not.toContain("visibility");
  expect(keys).not.toContain("publishedAt");
  expect(keys).not.toContain("mergedIntoId");
  expect(keys).not.toContain("observationIds");
  expect(JSON.stringify(publicIncident)).not.toContain("0.72");
});

test("source free-text in the location never surfaces", () => {
  // An incident location has no raw/normalized fields at all; forcing them in shows both
  // the type boundary and the projection dropping them.
  const incident = anIncident({
    location: {
      raw: "RP AT 123 SECRET LN APT 4, CALLER IS THE VICTIM",
      normalized: "100 block of Secret Ln",
      displayName: "100 block of Secret Ln",
      neighborhood: "Mission",
      latitude: 37.76,
      longitude: -122.42,
    } as Incident["location"],
  });
  const serialized = JSON.stringify(toPublicIncident(incident));

  expect(serialized).not.toContain("CALLER IS THE VICTIM");
  expect(serialized).not.toContain("APT 4");
  expect(serialized).toContain("100 block of Secret Ln");
});

test("the incident validator itself strips undeclared fields", () => {
  const validated = parse(IncidentSchema, {
    ...anIncident(),
    officer_name: "Officer Fictional",
  });
  expect(Object.keys(validated)).not.toContain("officer_name");
});

test("the projection validates against the public schema", () => {
  const publicIncident = toPublicIncident(anIncident());
  expect(parse(PublicIncidentSchema, publicIncident)).toEqual(publicIncident);
});

test("timeline entries are published without their internal ids", () => {
  const [entry] = toPublicIncident(anIncident()).timeline;
  expect(Object.keys(entry ?? {})).toEqual(["occurredAt", "kind", "text"]);
});

test("optional fields are omitted rather than serialized as null", () => {
  const incident = anIncident();
  delete incident.summary;
  delete incident.severity;
  delete incident.priority;
  const serialized = JSON.stringify(toPublicIncident(incident));

  expect(serialized).not.toContain("null");
  expect(serialized).not.toContain("summary");
});
