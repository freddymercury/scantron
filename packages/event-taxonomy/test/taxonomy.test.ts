import { expect, test } from "bun:test";
import { createTestDatabase } from "@scantron/database/testing";
import { INCIDENT_TYPES } from "@scantron/incident-schema";
import {
  CONFIG_DIR,
  UNKNOWN_CONFIDENCE,
  createTaxonomy,
  loadTaxonomyConfigs,
  seedTaxonomy,
  taxonomyRows,
  type TaxonomyFile,
} from "../src/index.ts";

function seeded(files?: TaxonomyFile[]) {
  const db = createTestDatabase();
  seedTaxonomy(db, files ?? loadTaxonomyConfigs());
  return db;
}

test("the shipped configs cover the three CAD sources and validate", () => {
  const files = loadTaxonomyConfigs(CONFIG_DIR);
  expect(files.map((file) => file.source).sort()).toEqual([
    "sf_ems_cad",
    "sf_fire_cad",
    "sf_police_cad",
  ]);
  for (const file of files) {
    expect(file.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    for (const mapping of file.mappings) {
      expect(INCIDENT_TYPES).toContain(mapping.normalizedType);
      expect(mapping.rawCode ?? mapping.rawLabelPattern).toBeTruthy();
    }
  }
});

test("every normalized type used is one of PRD §10's, and nothing else", () => {
  const db = seeded();
  const used = new Set(taxonomyRows(db).map((row) => row.normalized_type));
  for (const type of used) expect([...INCIDENT_TYPES] as string[]).toContain(type);
  db.close();
});

test("real SFPD codes classify as expected", () => {
  const db = seeded();
  const taxonomy = createTaxonomy(db);
  const cases: [string, string][] = [
    ["219", "assault"],
    ["221", "weapon"],
    ["211", "robbery"],
    ["459", "burglary"],
    ["488", "theft"],
    ["519", "collision"],
    ["587", "traffic"],
    ["801", "medical"],
    ["807", "missing_person"],
    ["415", "disturbance"],
  ];
  for (const [code, expected] of cases) {
    const result = taxonomy.classify({ source: "sf_police_cad", rawCode: code });
    expect(`${code}: ${result.type}`).toBe(`${code}: ${expected}`);
    expect(result.matchedBy).toBe("code");
  }
  db.close();
});

test("real SFFD call types classify as expected", () => {
  const db = seeded();
  const taxonomy = createTaxonomy(db);
  expect(taxonomy.classify({ source: "sf_fire_cad", rawCode: "Medical Incident" }).type).toBe("medical");
  expect(
    taxonomy.classify({ source: "sf_fire_cad", rawCode: "Structure Fire / Smoke in Building" }),
  ).toMatchObject({ type: "fire", severity: "high" });
  expect(taxonomy.classify({ source: "sf_fire_cad", rawCode: "Traffic Collision" }).type).toBe("collision");
  expect(taxonomy.classify({ source: "sf_fire_cad", rawCode: "Water Rescue" }).type).toBe("rescue");
  db.close();
});

test("an exact code beats a label pattern, always", () => {
  const db = seeded([
    {
      version: "test.1",
      source: "sf_police_cad",
      mappings: [
        { rawCode: "999", normalizedType: "theft", typeConfidence: 0.9 },
        { rawLabelPattern: "FIRE", normalizedType: "fire", typeConfidence: 0.6 },
      ],
    },
  ]);
  const taxonomy = createTaxonomy(db);

  // The label screams fire; the code says theft. The agency's own code wins.
  const result = taxonomy.classify({
    source: "sf_police_cad",
    rawCode: "999",
    rawLabel: "STRUCTURE FIRE",
  });
  expect(result.type).toBe("theft");
  expect(result.matchedBy).toBe("code");

  // With no code match, the pattern is allowed to speak.
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "998", rawLabel: "STRUCTURE FIRE" })).toMatchObject({
    type: "fire",
    matchedBy: "pattern",
  });
  db.close();
});

test("codes match case-insensitively", () => {
  const db = seeded();
  const taxonomy = createTaxonomy(db);
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "418dv" }).matchedBy).toBe("code");
  db.close();
});

test("an unmapped code is Unknown at 0.2, counted, with its raw value kept", () => {
  const db = seeded();
  const unmapped: { source: string; rawCode?: string; rawLabel?: string }[] = [];
  const taxonomy = createTaxonomy(db, { onUnmapped: (event) => unmapped.push(event) });

  const result = taxonomy.classify({
    source: "sf_police_cad",
    rawCode: "ZZ9",
    rawLabel: "SOMETHING NEW",
  });
  expect(result).toMatchObject({
    type: "unknown",
    confidence: UNKNOWN_CONFIDENCE,
    matchedBy: "unmapped",
    rawCode: "ZZ9",
    rawLabel: "SOMETHING NEW",
  });
  expect(unmapped).toEqual([{ source: "sf_police_cad", rawCode: "ZZ9", rawLabel: "SOMETHING NEW" }]);
  db.close();
});

test("an unknown source is unmapped rather than an error", () => {
  const db = seeded();
  const taxonomy = createTaxonomy(db);
  expect(taxonomy.classify({ source: "chp_cad", rawCode: "1179" }).type).toBe("unknown");
  db.close();
});

test("re-seeding replaces a source rather than accumulating stale rules", () => {
  const db = seeded();
  const before = taxonomyRows(db).filter((row) => row.source === "sf_police_cad").length;
  expect(before).toBeGreaterThan(50);

  seedTaxonomy(db, [
    {
      version: "test.2",
      source: "sf_police_cad",
      mappings: [{ rawCode: "219", normalizedType: "theft", typeConfidence: 0.9 }],
    },
  ]);

  const after = taxonomyRows(db).filter((row) => row.source === "sf_police_cad");
  expect(after).toHaveLength(1);
  // A rule deleted from config stops classifying.
  const taxonomy = createTaxonomy(db);
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "459" }).type).toBe("unknown");
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "219" }).type).toBe("theft");
  db.close();
});

test("a config change reaches a running process within the reload interval", () => {
  const db = seeded([
    {
      version: "test.1",
      source: "sf_police_cad",
      mappings: [{ rawCode: "219", normalizedType: "assault", typeConfidence: 0.9 }],
    },
  ]);

  let clock = 1_000_000;
  const taxonomy = createTaxonomy(db, { reloadIntervalMs: 60_000, now: () => clock });
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "219" }).type).toBe("assault");

  seedTaxonomy(db, [
    {
      version: "test.2",
      source: "sf_police_cad",
      mappings: [{ rawCode: "219", normalizedType: "weapon", typeConfidence: 0.95 }],
    },
  ]);

  // Still cached a second later — no per-classification query.
  clock += 1_000;
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "219" }).type).toBe("assault");

  // Picked up once the interval has passed, with no restart.
  clock += 60_000;
  expect(taxonomy.classify({ source: "sf_police_cad", rawCode: "219" }).type).toBe("weapon");
  db.close();
});

test("a malformed mapping is rejected when it is written, not when it is used", () => {
  const db = createTestDatabase();
  expect(() =>
    seedTaxonomy(db, [
      {
        version: "test.1",
        source: "sf_police_cad",
        mappings: [{ rawCode: "219", normalizedType: "arson" as never, typeConfidence: 0.9 }],
      },
    ]),
  ).toThrow();
  db.close();
});

test("a malformed config file fails validation on load", async () => {
  const path = `${(await import("node:os")).tmpdir()}/scantron-bad-taxonomy.json`;
  await Bun.write(
    path,
    JSON.stringify({ version: "x", source: "sf_police_cad", mappings: [{ typeConfidence: 3 }] }),
  );
  const { loadTaxonomyFile } = await import("../src/index.ts");
  expect(() => loadTaxonomyFile(path)).toThrow(/normalizedType|typeConfidence/);
});
