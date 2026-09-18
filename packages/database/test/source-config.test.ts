import { expect, test } from "bun:test";
import {
  configChanges,
  createConfigCache,
  effectivePollSeconds,
  ensureSourceConfiguration,
  readSourceConfig,
  recordPollFailure,
  recordPollSuccess,
  updateSourceConfig,
} from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

function seeded() {
  const db = createTestDatabase();
  ensureSourceConfiguration(db, {
    source: "sf_police_cad",
    datasetId: "gnap-fj3t",
    pollSeconds: 60,
    healthMaxSilenceSeconds: 3600,
    endpoint: "/resource/gnap-fj3t.json",
  });
  return db;
}

test("a source registers with every knob S-B3 asks for", () => {
  const db = seeded();
  const config = readSourceConfig(db, "sf_police_cad");
  expect(config).toMatchObject({
    source: "sf_police_cad",
    datasetId: "gnap-fj3t",
    endpoint: "/resource/gnap-fj3t.json",
    enabled: true,
    pollSeconds: 60,
    overlapSeconds: 120,
    healthMaxSilenceSeconds: 3600,
    defaultVisibility: "public",
    publicationDelaySeconds: 180,
    consecutiveFailures: 0,
  });
  db.close();
});

test("registering again never overwrites an operator's edits", () => {
  const db = seeded();
  updateSourceConfig(db, "sf_police_cad", { pollSeconds: 300, enabled: false });

  ensureSourceConfiguration(db, { source: "sf_police_cad", datasetId: "gnap-fj3t", pollSeconds: 60 });

  const config = readSourceConfig(db, "sf_police_cad");
  expect(config?.pollSeconds).toBe(300);
  expect(config?.enabled).toBe(false);
  db.close();
});

test("config changes are logged with before and after", () => {
  const db = seeded();
  const changes = updateSourceConfig(
    db,
    "sf_police_cad",
    { pollSeconds: 120, enabled: false },
    { changedBy: "operator" },
  );

  expect(changes).toEqual([
    { field: "pollSeconds", from: "60", to: "120" },
    { field: "enabled", from: "true", to: "false" },
  ]);

  const logged = configChanges(db, "sf_police_cad");
  expect(logged).toHaveLength(2);
  expect(logged[0]?.changed_by).toBe("operator");
  // Setting a field to what it already is is not a change.
  expect(updateSourceConfig(db, "sf_police_cad", { pollSeconds: 120 })).toEqual([]);
  db.close();
});

test("poller state is persisted across polls", () => {
  const db = seeded();
  recordPollSuccess(db, "sf_police_cad", "2026-09-18T01:00:00.000Z", new Date("2026-09-18T01:01:00.000Z"));
  let config = readSourceConfig(db, "sf_police_cad");
  expect(config?.cursor).toBe("2026-09-18T01:00:00.000Z");
  expect(config?.lastSuccessAt).toBe("2026-09-18T01:01:00.000Z");
  expect(config?.consecutiveFailures).toBe(0);

  recordPollFailure(db, "sf_police_cad", "503 Service Unavailable");
  config = readSourceConfig(db, "sf_police_cad");
  expect(config?.consecutiveFailures).toBe(1);
  expect(config?.lastError).toContain("503");
  // A failure does not move the cursor.
  expect(config?.cursor).toBe("2026-09-18T01:00:00.000Z");
  db.close();
});

test("a failing source backs off instead of hammering the endpoint", () => {
  const base = {
    source: "s",
    datasetId: "d",
    enabled: true,
    pollSeconds: 60,
    overlapSeconds: 120,
    healthMaxSilenceSeconds: 3600,
    defaultVisibility: "public" as const,
    publicationDelaySeconds: 180,
    backoffAfterFailures: 3,
    maxPollSeconds: 1800,
    consecutiveFailures: 0,
  };

  expect(effectivePollSeconds(base)).toBe(60);
  expect(effectivePollSeconds({ ...base, consecutiveFailures: 2 })).toBe(60);
  expect(effectivePollSeconds({ ...base, consecutiveFailures: 3 })).toBe(120);
  expect(effectivePollSeconds({ ...base, consecutiveFailures: 4 })).toBe(240);
  // And it stops doubling before it stops polling altogether.
  expect(effectivePollSeconds({ ...base, consecutiveFailures: 40 })).toBe(1800);
});

test("disabling a source is picked up without a restart", () => {
  const db = seeded();
  let clock = 1_000_000;
  const cache = createConfigCache(db, { reloadIntervalMs: 60_000, now: () => clock });

  expect(cache.get("sf_police_cad")?.enabled).toBe(true);

  updateSourceConfig(db, "sf_police_cad", { enabled: false });
  // Still cached a second later: the poller is not querying config every pass.
  clock += 1_000;
  expect(cache.get("sf_police_cad")?.enabled).toBe(true);

  // Picked up inside the S-B3 window.
  clock += 60_000;
  expect(cache.get("sf_police_cad")?.enabled).toBe(false);
  db.close();
});
