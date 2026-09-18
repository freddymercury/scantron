import { expect, test } from "bun:test";
import {
  INCIDENT_EVENT_TYPES,
  IncidentEventSchema,
  parse,
  toPublicIncident,
  type IncidentEvent,
} from "../src/index.ts";
import { anIncident } from "./fixtures.ts";

const anEvent = (overrides: Partial<IncidentEvent> = {}): IncidentEvent => ({
  id: "evt_1",
  type: "incident.created",
  at: "2026-09-18T01:14:00.000Z",
  incident: toPublicIncident(anIncident()),
  ...overrides,
});

test("all four event types validate", () => {
  for (const type of INCIDENT_EVENT_TYPES) {
    expect(parse(IncidentEventSchema, anEvent({ type })).type).toBe(type);
  }
});

test("a merged event carries the absorbed incident id", () => {
  const event = parse(IncidentEventSchema, anEvent({ type: "incident.merged", mergedFromId: "inc_2" }));
  expect(event.mergedFromId).toBe("inc_2");
});

test("an unknown event type is rejected", () => {
  expect(IncidentEventSchema.validate(anEvent({ type: "incident.exploded" as never })).ok).toBe(false);
});

test("the event payload cannot smuggle internal fields", () => {
  const event = parse(IncidentEventSchema, {
    ...anEvent(),
    internalNote: "do not ship",
    incident: { ...toPublicIncident(anIncident()), visibility: "restricted", confidence: 0.9 },
  });
  expect(JSON.stringify(event)).not.toContain("internalNote");
  expect(JSON.stringify(event)).not.toContain("restricted");
  expect(JSON.stringify(event)).not.toContain("0.9");
});
