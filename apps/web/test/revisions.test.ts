/**
 * Reading a republication (S-D7 prep). The property that matters: a fetch that changed
 * nothing but its own timestamps is not a revision.
 */

import { expect, test } from "bun:test";

import { diffPayloads, revisions } from "../src/internal/revisions.ts";

test("only the fields that actually moved come back", () => {
  const changes = diffPayloads(
    { cad_number: "1", call_type_final_desc: "PERSON W/GUN", disposition: undefined },
    { cad_number: "1", call_type_final_desc: "MENTALLY DISTURBED PERSON", disposition: "HAN" },
  );

  expect(changes.map((change) => change.field)).toEqual(["call_type_final_desc", "disposition"]);
  expect(changes[0]).toMatchObject({
    kind: "changed",
    before: "PERSON W/GUN",
    after: "MENTALLY DISTURBED PERSON",
  });
  expect(changes[1]?.kind).toBe("added");
});

test("a republication that only bumped its own timestamps is not a revision", () => {
  // This is the churn that once cost 34,000 jobs an hour and 2.5 million stored payloads.
  const changes = diffPayloads(
    { cad_number: "1", data_as_of: "2026-09-21T10:00:00", data_loaded_at: "2026-09-21T10:05:00" },
    { cad_number: "1", data_as_of: "2026-09-21T11:00:00", data_loaded_at: "2026-09-21T11:05:00" },
  );
  expect(changes).toEqual([]);
});

test("a cleared field is a removal, not a silent disappearance", () => {
  const changes = diffPayloads({ disposition: "REP" }, { disposition: "" });
  expect(changes[0]).toMatchObject({ field: "disposition", kind: "removed", before: "REP" });
});

test("versions are read oldest-first, and quiet republications produce nothing", () => {
  const payloads = [
    { fetched_at: "2026-09-21T12:00:00Z", payload: JSON.stringify({ a: "2", data_as_of: "z" }) },
    { fetched_at: "2026-09-21T10:00:00Z", payload: JSON.stringify({ a: "1" }) },
    { fetched_at: "2026-09-21T11:00:00Z", payload: JSON.stringify({ a: "1", data_as_of: "y" }) },
  ];

  const result = revisions(payloads);
  expect(result).toHaveLength(1);
  expect(result[0]?.at).toBe("2026-09-21T12:00:00Z");
  expect(result[0]?.changes[0]).toMatchObject({ field: "a", before: "1", after: "2" });
});

test("one version is no revision at all", () => {
  expect(revisions([{ fetched_at: "2026-09-21T10:00:00Z", payload: "{}" }])).toEqual([]);
  expect(revisions([])).toEqual([]);
});

test("one row per unit is not a revision of another unit", () => {
  // SFFD publishes a row per unit, all stored under the same CAD number. Diffing them in
  // fetch order would report a dozen fields "changed" when two units simply differ.
  const payloads = [
    {
      fetched_at: "2026-09-18T10:00:00Z",
      payload: JSON.stringify({ rowid: "262580837-T05", unit_id: "T05", on_scene_dttm: "" }),
    },
    {
      fetched_at: "2026-09-18T10:00:01Z",
      payload: JSON.stringify({ rowid: "262580837-T03", unit_id: "T03", on_scene_dttm: "" }),
    },
    {
      fetched_at: "2026-09-18T11:00:00Z",
      payload: JSON.stringify({
        rowid: "262580837-T05",
        unit_id: "T05",
        on_scene_dttm: "2026-09-15T08:41:10.000",
      }),
    },
  ];

  const result = revisions(payloads);
  // Exactly one revision: T05 reported on scene. T03 is a different row, not an edit.
  expect(result).toHaveLength(1);
  expect(result[0]?.series).toBe("262580837-T05");
  expect(result[0]?.changes).toHaveLength(1);
  expect(result[0]?.changes[0]).toMatchObject({ field: "on_scene_dttm", kind: "added" });
});

test("SFPD's re-issued row id does not split a call into one-version series", () => {
  // Measured on live data: five stored versions of one call carried five different `id`s.
  // Grouping on that would report that this feed never revises anything, which is false.
  const payloads = [
    {
      fetched_at: "2026-09-20T10:00:00Z",
      payload: JSON.stringify({ id: "41048729", cad_number: "262622741", call_type_final_desc: "PERSON W/GUN" }),
    },
    {
      fetched_at: "2026-09-20T11:00:00Z",
      payload: JSON.stringify({ id: "41050711", cad_number: "262622741", call_type_final_desc: "MENTALLY DISTURBED PERSON" }),
    },
  ];

  const result = revisions(payloads);
  expect(result).toHaveLength(1);
  // The re-issued `id` is noise on every revision, so it is not reported as a change.
  expect(result[0]?.changes.map((change) => change.field)).toEqual(["call_type_final_desc"]);
});
