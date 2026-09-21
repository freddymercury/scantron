/**
 * The fields normalization drops (S-F4 colour). Every case here is a real shape from the
 * live feeds, including the trap that makes them dangerous: naive SF-local timestamps.
 */

import { expect, test } from "bun:test";

import { elapsed, firstOnScene, recordFacts, unitResponses } from "../src/internal/dispatch.ts";

const FIRE_METADATA = {
  unit_timestamps: {
    B02: {
      dispatch: "2026-09-21T02:09:36.000",
      response: "2026-09-21T02:11:19.000",
      on_scene: "2026-09-21T02:14:56.000",
      available: "2026-09-21T02:28:11.000",
      unit_type: "CHIEF",
    },
    T06: {
      dispatch: "2026-09-21T02:09:36.000",
      on_scene: "2026-09-21T02:22:12.000",
      unit_type: "TRUCK",
    },
    E06: {
      dispatch: "2026-09-21T02:09:36.000",
      on_scene: "2026-09-21T02:14:49.000",
      unit_type: "ENGINE",
    },
  },
  call_type_group: "Potentially Life-Threatening",
  als_unit: true,
  battalion: "B02",
  station_area: "01",
  supervisor_district: "6",
  call_final_disposition: "Other",
};

test("unit timestamps are read as San Francisco local, not UTC", () => {
  const responses = unitResponses(FIRE_METADATA);
  // 02:09:36 in SF on 21 September is 09:09:36 UTC. Read as UTC it would be seven hours
  // early — the mistake docs/01 exists to prevent.
  expect(responses[0]?.dispatch).toBe("2026-09-21T09:09:36.000Z");
});

test("units are ordered by who reported on scene first", () => {
  const responses = unitResponses(FIRE_METADATA);
  expect(responses.map((response) => response.unit)).toEqual(["E06", "B02", "T06"]);
  expect(firstOnScene(responses)?.unit).toBe("E06");
  expect(elapsed(responses[0]?.dispatch, responses[0]?.onScene)).toBe("5 min 13 s");
});

test("a unit that never reported a step is a dash, not a zero", () => {
  const responses = unitResponses(FIRE_METADATA);
  const truck = responses.find((response) => response.unit === "T06");
  expect(truck?.response).toBeUndefined();
  expect(truck?.available).toBeUndefined();
  expect(elapsed(truck?.dispatch, truck?.response)).toBeUndefined();
});

test("a record with no unit timestamps yields nothing rather than throwing", () => {
  expect(unitResponses(undefined)).toEqual([]);
  expect(unitResponses({ unit_timestamps: null })).toEqual([]);
  expect(unitResponses({})).toEqual([]);
});

test("elapsed speaks in the unit that fits", () => {
  expect(elapsed("2026-09-21T00:00:00Z", "2026-09-21T00:00:38Z")).toBe("38 s");
  expect(elapsed("2026-09-21T00:00:00Z", "2026-09-21T00:04:00Z")).toBe("4 min");
  expect(elapsed("2026-09-21T00:00:00Z", "2026-09-21T00:04:52Z")).toBe("4 min 52 s");
  // A clock that went backwards is not a negative duration, it is no answer.
  expect(elapsed("2026-09-21T00:05:00Z", "2026-09-21T00:00:00Z")).toBeUndefined();
});

test("an on-view call says so — it is a different kind of event", () => {
  const facts = recordFacts({ onview_flag: "Y" });
  expect(facts[0]?.value).toContain("came across this themselves");
  expect(facts[0]?.notable).toBe(true);
  expect(recordFacts({ onview_flag: "N" })).toHaveLength(0);
});

test("a call that turned out to be something else says both", () => {
  const facts = recordFacts({
    call_type_original_desc: "PERSON W/GUN",
    call_type_final_desc: "MENTALLY DISTURBED PERSON",
  });
  const changed = facts.find((entry) => entry.label === "changed en route");
  expect(changed?.value).toBe("reported as PERSON W/GUN, closed as MENTALLY DISTURBED PERSON");
  expect(changed?.notable).toBe(true);

  // Unchanged is the common case and says nothing.
  expect(
    recordFacts({ call_type_original_desc: "FIRE", call_type_final_desc: "FIRE" }).find(
      (entry) => entry.label === "changed en route",
    ),
  ).toBeUndefined();
});

test("a disposition code becomes plain words, keeping the code", () => {
  expect(recordFacts({ disposition: "REP" }).find((entry) => entry.label === "outcome")?.value).toBe(
    "closed with a report taken (REP)",
  );
  const goa = recordFacts({ disposition: "GOA" }).find((entry) => entry.label === "outcome");
  expect(goa?.value).toBe("closed with nothing found (GOA)");
  expect(goa?.notable).toBe(true);
});

test("the fire and EMS extras come through", () => {
  const facts = recordFacts(FIRE_METADATA);
  const labels = facts.map((entry) => entry.label);
  expect(labels).toContain("call group");
  expect(labels).toContain("medical");
  expect(labels).toContain("station");
  expect(facts.find((entry) => entry.label === "call group")?.notable).toBe(true);
  expect(facts.find((entry) => entry.label === "station")?.value).toBe("battalion B02 · station 01");
});

test("a unit's kind is a word and survives the timestamp parser", () => {
  const responses = unitResponses(FIRE_METADATA);
  expect(responses.map((response) => response.unitType)).toEqual(["ENGINE", "CHIEF", "TRUCK"]);
});
