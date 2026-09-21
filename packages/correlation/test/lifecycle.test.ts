import { expect, test } from "bun:test";

import {
  DEFAULT_STALENESS,
  DISPOSITION_REASONS,
  nextStatus,
  resolutionReason,
  staleStatus,
  stalenessMinutes,
  statusRank,
  type LifecycleSignals,
} from "../src/index.ts";

const RECEIVED = "2026-09-21T18:00:00.000Z";

const signals = (overrides: LifecycleSignals = {}): LifecycleSignals => ({
  receivedAt: RECEIVED,
  ...overrides,
});

test("status follows the agency's own timestamps", () => {
  expect(nextStatus("unknown", signals()).status).toBe("reported");
  expect(nextStatus("reported", signals({ dispatchedAt: RECEIVED })).status).toBe("dispatched");
  expect(nextStatus("reported", signals({ enrouteAt: RECEIVED })).status).toBe("dispatched");
  expect(nextStatus("dispatched", signals({ onSceneAt: RECEIVED })).status).toBe("active");
  expect(nextStatus("active", signals({ closedAt: RECEIVED, disposition: "HAN" })).status).toBe("resolved");
});

test("a record with no lifecycle timestamps leaves the status unknown, not assumed", () => {
  const decision = nextStatus("unknown", {});
  expect(decision.status).toBe("unknown");
  expect(decision.reason).toContain("no lifecycle timestamps");
});

test("resolvedAt comes only from an explicit close, never from inference", () => {
  const closed = nextStatus("active", signals({ closedAt: "2026-09-21T18:31:00.000Z", disposition: "REP" }));
  expect(closed.resolvedAt).toBe("2026-09-21T18:31:00.000Z");
  expect(closed.resolution).toBe("report_taken");

  // Every other transition leaves it unset.
  for (const decision of [
    nextStatus("unknown", signals()),
    nextStatus("reported", signals({ dispatchedAt: RECEIVED })),
    nextStatus("dispatched", signals({ onSceneAt: RECEIVED })),
  ]) {
    expect(decision.resolvedAt).toBeUndefined();
  }
});

test("dispositions carry what actually happened, including nothing", () => {
  // ~20% of SFPD calls resolve to explicitly-nothing-found (docs/01 §2), which is a fact
  // worth keeping rather than flattening into "closed".
  expect(resolutionReason("GOA")).toBe("nothing_found");
  expect(resolutionReason("UTL")).toBe("nothing_found");
  expect(resolutionReason("NOM")).toBe("nothing_found");
  expect(resolutionReason("REP")).toBe("report_taken");
  expect(resolutionReason("ARR")).toBe("enforcement");
  expect(resolutionReason("HAN")).toBe("handled");
  expect(resolutionReason("hAn")).toBe("handled");
  // An unrecognised code is unknown, not guessed into a bucket.
  expect(resolutionReason("ZZZ")).toBe("unknown");
  expect(resolutionReason(null)).toBe("unknown");
  expect(Object.keys(DISPOSITION_REASONS).length).toBeGreaterThan(8);

  const closed = nextStatus("active", signals({ closedAt: RECEIVED, disposition: "GOA" }));
  expect(closed.reason).toContain("nothing found");
});

test("status does not regress just because a later record says less", () => {
  // A revised record that carries only a received time must not un-dispatch an incident.
  const decision = nextStatus("active", signals());
  expect(decision.status).toBe("active");
  expect(decision.regressionBlocked).toBe(true);
  expect(decision.reason).toContain("not evidence the event went backwards");

  // A correction may do it explicitly (S-D7).
  expect(nextStatus("active", signals(), { allowRegression: true }).status).toBe("reported");
});

test("progress order is what regression is measured against", () => {
  expect(statusRank("reported")).toBeLessThan(statusRank("dispatched"));
  expect(statusRank("dispatched")).toBeLessThan(statusRank("active"));
  expect(statusRank("active")).toBeLessThan(statusRank("resolved"));
  // `unknown` sits outside the ladder: it is an absence of information, not a stage.
  expect(statusRank("unknown")).toBe(-1);
});

test("silence makes an incident unknown, and never resolved", () => {
  const now = new Date("2026-09-21T19:00:00.000Z");
  const quiet = staleStatus("active", "2026-09-21T18:00:00.000Z", "assault", now);

  expect(quiet?.status).toBe("unknown");
  expect(quiet?.reason).toContain("not resolved");
  expect(quiet?.resolvedAt).toBeUndefined();

  // Still inside its window: nothing to say.
  expect(staleStatus("active", "2026-09-21T18:30:00.000Z", "assault", now)).toBeUndefined();
});

test("how long counts as quiet depends on what kind of call it is", () => {
  // A structure fire runs for hours; a traffic stop does not.
  expect(stalenessMinutes("fire")).toBe(180);
  expect(stalenessMinutes("rescue")).toBe(180);
  expect(stalenessMinutes("traffic")).toBe(DEFAULT_STALENESS.defaultMinutes);
  expect(stalenessMinutes(null)).toBe(DEFAULT_STALENESS.defaultMinutes);

  const now = new Date("2026-09-21T20:00:00.000Z");
  // Ninety minutes of quiet: over for an assault, nothing for a fire.
  expect(staleStatus("active", "2026-09-21T18:30:00.000Z", "assault", now)?.status).toBe("unknown");
  expect(staleStatus("active", "2026-09-21T18:30:00.000Z", "fire", now)).toBeUndefined();
});

test("a resolved incident is left alone by the staleness sweep", () => {
  const now = new Date("2026-09-22T00:00:00.000Z");
  expect(staleStatus("resolved", "2026-09-21T18:00:00.000Z", "assault", now)).toBeUndefined();
  // And one already unknown is not re-reported every sweep.
  expect(staleStatus("unknown", "2026-09-21T18:00:00.000Z", "assault", now)).toBeUndefined();
});

test("the machine is total: every status and signal shape returns something", () => {
  const statuses = ["reported", "dispatched", "active", "contained", "resolved", "unknown"] as const;
  const shapes: LifecycleSignals[] = [
    {},
    { receivedAt: RECEIVED },
    { receivedAt: RECEIVED, dispatchedAt: RECEIVED },
    { receivedAt: RECEIVED, onSceneAt: RECEIVED },
    { receivedAt: RECEIVED, closedAt: RECEIVED },
    { closedAt: RECEIVED, disposition: "GOA" },
    { fireDisposition: "Fire" },
  ];
  for (const status of statuses) {
    for (const shape of shapes) {
      const decision = nextStatus(status, shape);
      expect(statuses).toContain(decision.status);
      expect(decision.reason.length).toBeGreaterThan(5);
    }
  }
});

test("lifecycle timestamps are read from metadata as San Francisco local time", async () => {
  const { signalsFromMetadata } = await import("../src/index.ts");
  const signals = signalsFromMetadata({
    received_datetime: "2026-09-21T09:02:03.000",
    dispatch_datetime: "2026-09-21T09:06:41.000",
    onscene_datetime: "2026-09-21T09:26:37.000",
    close_datetime: "2026-09-21T09:30:40.000",
    disposition: "REP",
  });

  // Read as UTC these would all be seven hours wrong (docs/01).
  expect(signals.receivedAt).toBe("2026-09-21T16:02:03.000Z");
  expect(signals.closedAt).toBe("2026-09-21T16:30:40.000Z");
  expect(signals.disposition).toBe("REP");
});

test("SFFD field names are read too, and a cleared unit is not a closed call", async () => {
  const { signalsFromMetadata } = await import("../src/index.ts");
  const signals = signalsFromMetadata({
    received_dttm: "2026-09-21T09:02:03.000",
    dispatch_dttm: "2026-09-21T09:04:03.000",
    on_scene_dttm: "2026-09-21T09:12:03.000",
    available_dttm: "2026-09-21T09:40:03.000",
    call_final_disposition: "Fire",
  });

  expect(signals.onSceneAt).toBeTruthy();
  // `available_dttm` means the unit went back in service, not that the call ended.
  expect(signals.closedAt).toBeUndefined();
  expect(signals.fireDisposition).toBe("Fire");
});

test("attaching an observation moves the status and writes why", async () => {
  const { migrate, openDatabase, IN_MEMORY, upsertObservation } = await import("@scantron/database");
  const { observationToRow } = await import("@scantron/incident-schema");
  const { applyDecision, sweepStaleIncidents } = await import("../src/index.ts");

  const db = openDatabase({ path: IN_MEMORY });
  migrate(db);

  const at = new Date("2026-09-21T16:02:03.000Z");
  const observation = {
    id: "obs_1",
    source: "sf_police_cad",
    occurredAt: at,
    lat: 37.7292,
    lng: -122.3957,
    neighborhood: "Bayview Hunters Point",
    type: "collision",
    locationCanonical: "Earl St & Gilman Ave",
  };
  upsertObservation(
    db,
    observationToRow({
      id: observation.id,
      source: "sf_police_cad",
      sourceRecordId: "1",
      occurredAt: at,
      ingestedAt: at,
      confidence: 0.6,
      type: "collision",
      location: { latitude: observation.lat, longitude: observation.lng },
    } as never),
  );

  applyDecision(db, {
    observation: observation as never,
    metadata: {
      received_datetime: "2026-09-21T09:02:03.000",
      dispatch_datetime: "2026-09-21T09:06:41.000",
      onscene_datetime: "2026-09-21T09:26:37.000",
    },
  });

  const incident = db.query<{ status: string; resolved_at: string | null }, []>(
    "SELECT status, resolved_at FROM incidents",
  ).get();
  expect(incident?.status).toBe("active");
  expect(incident?.resolved_at).toBeNull();

  const entry = db.query<{ kind: string; text: string; observation_id: string }, []>(
    "SELECT kind, text, observation_id FROM timeline_events",
  ).get();
  expect(entry?.kind).toBe("status_changed");
  expect(entry?.text).toContain("on scene");
  // PRD §32: the entry names its source.
  expect(entry?.observation_id).toBe("obs_1");

  // Two hours of silence on a collision (90 min limit): unknown, never resolved.
  const sweep = sweepStaleIncidents(db, new Date(at.getTime() + 120 * 60_000));
  expect(sweep.movedToUnknown).toBe(1);
  expect(db.query<{ status: string }, []>("SELECT status FROM incidents").get()?.status).toBe("unknown");
  expect(db.query<{ resolved_at: string | null }, []>("SELECT resolved_at FROM incidents").get()?.resolved_at).toBeNull();

  // Idempotent: running it again moves nothing.
  expect(sweepStaleIncidents(db, new Date(at.getTime() + 300 * 60_000)).movedToUnknown).toBe(0);
  db.close();
});
