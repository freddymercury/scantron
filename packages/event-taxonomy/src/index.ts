/**
 * @scantron/event-taxonomy — raw agency call codes → the PRD §10 taxonomy, by configuration.
 *
 * Classification changes are a config edit, not a deploy: the seed files under `config/`
 * are versioned, loaded into `event_taxonomy`, and re-read by running processes within
 * `reloadIntervalMs` (60 s by default, per S-A4).
 *
 * Precedence, and the reason it is that way round: **an exact code always beats a label
 * pattern.** Codes are the agency's own vocabulary; patterns are our guess for codes we
 * have never seen, and a guess must never override a fact.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  arrayOf,
  confidence,
  enumOf,
  objectOf,
  optional,
  parse,
  string,
  type IncidentSeverity,
  type IncidentType,
} from "@scantron/incident-schema";

export const CONFIG_DIR = resolve(import.meta.dir, "../config");
/** One file per source. Kept in its own directory so other config (priorities) can sit beside it. */
export const SOURCE_CONFIG_DIR = join(CONFIG_DIR, "sources");

/** Unmapped codes resolve here, and are counted so the gap is visible (S-A4). */
export const UNKNOWN_TYPE: IncidentType = "unknown";
export const UNKNOWN_CONFIDENCE = 0.2;

export const TaxonomyMappingSchema = objectOf(
  {
    rawCode: optional(string({ minLength: 1, maxLength: 60 })),
    rawLabel: optional(string({ maxLength: 120 })),
    rawLabelPattern: optional(string({ minLength: 1, maxLength: 200 })),
    normalizedType: enumOf(INCIDENT_TYPES),
    subtype: optional(string({ maxLength: 120 })),
    defaultSeverity: optional(enumOf(INCIDENT_SEVERITIES)),
    typeConfidence: confidence(),
  },
  "TaxonomyMapping",
);

export const TaxonomyFileSchema = objectOf(
  {
    version: string({ minLength: 1, maxLength: 40 }),
    source: string({ minLength: 1, maxLength: 40 }),
    note: optional(string({ maxLength: 1000 })),
    mappings: arrayOf(TaxonomyMappingSchema),
  },
  "TaxonomyFile",
);

export interface TaxonomyMapping {
  /** The agency's own code. Exact matches on this beat every pattern. */
  rawCode?: string;
  rawLabel?: string;
  /** Regular expression over the source's label, tried only when no code matched. */
  rawLabelPattern?: string;
  normalizedType: IncidentType;
  subtype?: string;
  defaultSeverity?: IncidentSeverity;
  typeConfidence: number;
}

export interface TaxonomyFile {
  version: string;
  source: string;
  note?: string;
  mappings: TaxonomyMapping[];
}

export interface Classification {
  type: IncidentType;
  subtype?: string;
  severity?: IncidentSeverity;
  confidence: number;
  /** How the mapping was found — useful in the raw observation viewer (S-B4). */
  matchedBy: "code" | "pattern" | "unmapped";
  rawCode?: string;
  rawLabel?: string;
}

/** Validated on load, so a malformed config fails at seed time rather than at classify time. */
export function loadTaxonomyFile(path: string): TaxonomyFile {
  const text = readFileSync(path, "utf8");
  return parse(TaxonomyFileSchema, JSON.parse(text) as unknown, path) as TaxonomyFile;
}

export function loadTaxonomyConfigs(dir: string = SOURCE_CONFIG_DIR): TaxonomyFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => loadTaxonomyFile(join(dir, name)));
}

export interface SeedResult {
  source: string;
  version: string;
  inserted: number;
}

/** Seed or re-seed `event_taxonomy` from config files. Idempotent; safe to run on boot. */
export function seedTaxonomy(
  db: Database,
  files: readonly TaxonomyFile[] = loadTaxonomyConfigs(),
  now: Date = new Date(),
): SeedResult[] {
  const insert = db.query(
    `INSERT INTO event_taxonomy
       (id, source, raw_code, raw_label_pattern, raw_label, normalized_type, subtype,
        default_severity, type_confidence, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const results: SeedResult[] = [];
  const run = db.transaction((file: TaxonomyFile) => {
    // Replace the whole source at once: a mapping deleted from config must disappear here
    // too, or a stale row would keep classifying long after the rule was removed.
    db.query("DELETE FROM event_taxonomy WHERE source = ?").run(file.source);
    for (const mapping of file.mappings) {
      insert.run(
        `tax_${file.source}_${mapping.rawCode ?? mapping.rawLabelPattern}`,
        file.source,
        mapping.rawCode ?? null,
        mapping.rawLabelPattern ?? null,
        mapping.rawLabel ?? null,
        mapping.normalizedType,
        mapping.subtype ?? null,
        mapping.defaultSeverity ?? null,
        mapping.typeConfidence,
        file.version,
        now.toISOString(),
      );
    }
  });

  for (const file of files) {
    run(file);
    results.push({ source: file.source, version: file.version, inserted: file.mappings.length });
  }
  return results;
}

interface CompiledMapping extends TaxonomyMapping {
  pattern?: RegExp;
}

interface SourceRules {
  byCode: Map<string, CompiledMapping>;
  patterns: CompiledMapping[];
}

export interface TaxonomyRow {
  source: string;
  raw_code: string | null;
  raw_label_pattern: string | null;
  raw_label: string | null;
  normalized_type: string;
  subtype: string | null;
  default_severity: string | null;
  type_confidence: number;
  version: string;
}

export function taxonomyRows(db: Database): TaxonomyRow[] {
  return db
    .query<TaxonomyRow, []>("SELECT * FROM event_taxonomy ORDER BY source, raw_code")
    .all();
}

export interface TaxonomyOptions {
  /** How stale the in-memory copy may get. S-A4 asks for at most 60 s. */
  reloadIntervalMs?: number;
  /** Called once per classification that found no mapping, with the raw value (S-A4). */
  onUnmapped?: (event: { source: string; rawCode?: string; rawLabel?: string }) => void;
  now?: () => number;
}

export interface Taxonomy {
  classify(input: {
    source: string;
    rawCode?: string | undefined;
    rawLabel?: string | undefined;
  }): Classification;
  /** Force a reload rather than waiting out the interval. */
  reload(): void;
  readonly loadedAt: number;
  readonly size: number;
}

/**
 * A hot-reloading view of `event_taxonomy`. Reads are from memory; the table is re-read at
 * most once per `reloadIntervalMs`, so a config change reaches every process within a
 * minute without a restart.
 */
export function createTaxonomy(db: Database, options: TaxonomyOptions = {}): Taxonomy {
  const reloadIntervalMs = options.reloadIntervalMs ?? 60_000;
  const clock = options.now ?? (() => Date.now());

  let rules = new Map<string, SourceRules>();
  let loadedAt = 0;
  let size = 0;

  function load(): void {
    const next = new Map<string, SourceRules>();
    const rows = taxonomyRows(db);
    for (const row of rows) {
      let source = next.get(row.source);
      if (!source) {
        source = { byCode: new Map(), patterns: [] };
        next.set(row.source, source);
      }
      const mapping: CompiledMapping = {
        normalizedType: row.normalized_type as IncidentType,
        typeConfidence: row.type_confidence,
      };
      if (row.subtype) mapping.subtype = row.subtype;
      if (row.default_severity) mapping.defaultSeverity = row.default_severity as IncidentSeverity;
      if (row.raw_label) mapping.rawLabel = row.raw_label;

      if (row.raw_code) {
        mapping.rawCode = row.raw_code;
        source.byCode.set(row.raw_code.toUpperCase(), mapping);
      } else if (row.raw_label_pattern) {
        mapping.rawLabelPattern = row.raw_label_pattern;
        mapping.pattern = new RegExp(row.raw_label_pattern, "i");
        source.patterns.push(mapping);
      }
    }
    rules = next;
    size = rows.length;
    loadedAt = clock();
  }

  function fresh(): void {
    if (clock() - loadedAt >= reloadIntervalMs) load();
  }

  load();

  return {
    get loadedAt() {
      return loadedAt;
    },
    get size() {
      return size;
    },
    reload: load,
    classify({ source, rawCode, rawLabel }): Classification {
      fresh();
      const sourceRules = rules.get(source);

      if (sourceRules && rawCode) {
        const exact = sourceRules.byCode.get(rawCode.toUpperCase());
        if (exact) return toClassification(exact, "code", rawCode, rawLabel);
      }
      if (sourceRules && rawLabel) {
        // Patterns are only consulted once an exact code match has failed.
        const matched = sourceRules.patterns.find((mapping) => mapping.pattern?.test(rawLabel));
        if (matched) return toClassification(matched, "pattern", rawCode, rawLabel);
      }

      options.onUnmapped?.({
        source,
        ...(rawCode === undefined ? {} : { rawCode }),
        ...(rawLabel === undefined ? {} : { rawLabel }),
      });
      const unmapped: Classification = {
        type: UNKNOWN_TYPE,
        confidence: UNKNOWN_CONFIDENCE,
        matchedBy: "unmapped",
      };
      if (rawCode !== undefined) unmapped.rawCode = rawCode;
      if (rawLabel !== undefined) unmapped.rawLabel = rawLabel;
      return unmapped;
    },
  };
}

function toClassification(
  mapping: CompiledMapping,
  matchedBy: "code" | "pattern",
  rawCode?: string,
  rawLabel?: string,
): Classification {
  const classification: Classification = {
    type: mapping.normalizedType,
    confidence: mapping.typeConfidence,
    matchedBy,
  };
  if (mapping.subtype !== undefined) classification.subtype = mapping.subtype;
  if (mapping.defaultSeverity !== undefined) classification.severity = mapping.defaultSeverity;
  if (rawCode !== undefined) classification.rawCode = rawCode;
  if (rawLabel !== undefined) classification.rawLabel = rawLabel;
  return classification;
}

export * from "./priority.ts";
