/**
 * The CAD join (S-I2). The interesting assertions are the refusals: a report with no key
 * is never guessed at, and a report never makes an incident look better corroborated.
 */

import { expect, test } from "bun:test";
import { upsertObservation } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import { applyDecision, joinReport, readTimeline, renderReport, reportKind } from "../src/index.ts";

const AT = new Date("2026-09-21T18:51:28.000Z");
const CORNER = { lat: 37.7292, lng: -122.3957 };

function seedCall(db: ReturnType<typeof createTestDatabase>): string {
  upsertObservation(
    db,
    observationToRow({
      id: "obs_sf_police_cad_262633905",
      source: "sf_police_cad",
      sourceRecordId: "262633905",
      occurredAt: AT,
      ingestedAt: AT,
      confidence: 0.6,
      type: "assault",
      location: { latitude: CORNER.lat, longitude: CORNER.lng, normalized: "16th St & Wiese St" },
    } as Observation),
  );
  return applyDecision(db, {
    observation: {
      id: "obs_sf_police_cad_262633905",
      source: "sf_police_cad",
      occurredAt: AT,
      lat: CORNER.lat,
      lng: CORNER.lng,
      type: "assault",
      locationCanonical: "16th St & Wiese St",
    },
  }).incidentId;
}

function storeReport(db: ReturnType<typeof createTestDatabase>, id: string, metadata: Record<string, unknown>) {
  upsertObservation(
    db,
    observationToRow({
      id,
      source: "sf_police_report",
      sourceRecordId: id.replace("obs_sf_police_report_", ""),
      occurredAt: AT,
      ingestedAt: AT,
      confidence: 1,
      type: "assault",
      metadata,
    } as Observation),
  );
  return { id, source: "sf_police_report", occurredAt: AT, metadata };
}

test("a report joins to the call it names, deterministically", () => {
  const db = createTestDatabase();
  const incidentId = seedCall(db);

  const report = storeReport(db, "obs_sf_police_report_160098504014", {
    cad_number: "262633905",
    incident_description: "Assault, Aggravated, W/ Force",
    resolution: "Cite or Arrest Adult",
    report_type_description: "Initial",
    report_datetime: "2026-09-23T00:03:00.000Z",
  });

  const result = joinReport(db, report);
  expect(result.outcome).toBe("joined");
  expect(result.incidentId).toBe(incidentId);

  const attachment = db
    .query<{ score: number; decision: string }, [string]>(
      "SELECT score, decision FROM incident_observations WHERE observation_id = ?",
    )
    .get(report.id);
  expect(attachment?.score).toBe(1);

  const entry = readTimeline(db, incidentId).find((row) => row.kind === "report_filed");
  expect(entry?.text).toBe(
    "SFPD filed an initial report: Assault, Aggravated, W/ Force. Case status: Cite or Arrest Adult.",
  );
  db.close();
});

test("a report with no cad_number is never guessed at", () => {
  const db = createTestDatabase();
  seedCall(db);

  const online = storeReport(db, "obs_sf_police_report_999", {
    filed_online: true,
    incident_description: "Theft, From Locked Vehicle",
  });
  expect(joinReport(db, online).outcome).toBe("unjoinable");

  // It is stored, and it is attached to nothing at all.
  expect(
    db.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM incident_observations WHERE observation_id = ?",
    ).get(online.id)?.n,
  ).toBe(0);
  db.close();
});

test("a cad_number with no call on file joins nothing rather than the nearest thing", () => {
  const db = createTestDatabase();
  seedCall(db);
  const orphan = storeReport(db, "obs_sf_police_report_111", { cad_number: "999999999" });
  expect(joinReport(db, orphan).outcome).toBe("no_matching_call");
  db.close();
});

test("several reports for one call land on one incident, once each", () => {
  const db = createTestDatabase();
  const incidentId = seedCall(db);

  // 1.71 report rows per cad_number is the measured average (docs/01 §1).
  for (const [id, description] of [
    ["obs_sf_police_report_1", "Warrant Arrest"],
    ["obs_sf_police_report_2", "Assault, Aggravated, W/ Force"],
  ]) {
    const report = storeReport(db, id!, { cad_number: "262633905", incident_description: description });
    expect(joinReport(db, report).incidentId).toBe(incidentId);
    // Replaying it changes nothing.
    expect(joinReport(db, report).outcome).toBe("already_attached");
  }

  expect(readTimeline(db, incidentId).filter((row) => row.kind === "report_filed")).toHaveLength(2);
  db.close();
});

test("a report does not make an incident look better corroborated", () => {
  const db = createTestDatabase();
  const incidentId = seedCall(db);
  const report = storeReport(db, "obs_sf_police_report_5", { cad_number: "262633905" });
  joinReport(db, report);

  const incident = db
    .query<{ source_count: number; independent_source_count: number; classification: string }, [string]>(
      `SELECT source_count, independent_source_count,
              verification_classification AS classification FROM incidents WHERE id = ?`,
    )
    .get(incidentId);

  // One call, one report, one agency: still a single-source incident.
  expect(incident?.source_count).toBe(1);
  expect(incident?.independent_source_count).toBe(1);
  expect(incident?.classification).toBe("reported");
  db.close();
});

test("the timeline line states the case file, not a conclusion about a person", () => {
  expect(renderReport({ description: "Burglary, Hot Prowl, Forcible Entry", resolution: "Open or Active" })).toBe(
    "SFPD filed a report: Burglary, Hot Prowl, Forcible Entry. Case status: Open or Active.",
  );
  // No resolution is silence, not an assumption.
  expect(renderReport({ category: "Assault" })).toBe("SFPD filed a report: Assault.");
});

test("the kind of report is named, because the words carry meaning", () => {
  // A supplement adds to a report that already exists; saying "initial supplement report"
  // is both wrong and unreadable.
  expect(reportKind("Initial Supplement")).toBe("supplement");
  expect(reportKind("Initial")).toBe("initial report");
  expect(reportKind("Vehicle Initial")).toBe("vehicle report");
  // Coplogic means a member of the public filed it online, not that an officer wrote it.
  expect(reportKind("Coplogic Initial")).toBe("online-filed initial report");
  expect(reportKind("Coplogic Supplement")).toBe("online-filed supplement");
  expect(reportKind(undefined)).toBe("report");

  // The article follows the word.
  expect(renderReport({ reportType: "Initial", category: "Assault" })).toContain("filed an initial report");
  expect(renderReport({ reportType: "Initial Supplement", category: "Assault" })).toContain("filed a supplement");
});
