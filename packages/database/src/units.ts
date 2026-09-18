/**
 * The unit registry (S-C4): every apparatus the feeds have mentioned, with what it is and
 * when we first and last saw it.
 *
 * `incident_units` records a unit once per incident with its first-seen time, however many
 * observations mention it — a five-observation fire with one engine has one engine on it.
 */

import type { Database } from "bun:sqlite";
import { parseUnit, type ParsedUnit } from "@scantron/sf-domain";

export interface UnitRow {
  id: string;
  designator: string;
  agency_type: string | null;
  kind: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export function unitId(designator: string): string {
  return `unit_${designator}`;
}

/** Register (or refresh) a unit. Returns the parsed form, unknown class included. */
export function recordUnit(
  db: Database,
  raw: string,
  seenAt: Date,
  hints: { unitType?: string | undefined; source?: string | undefined } = {},
): ParsedUnit | undefined {
  const parsed = parseUnit(raw, hints);
  if (!parsed.designator) return undefined;

  db.query(
    `INSERT INTO units (id, designator, agency_type, kind, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (designator) DO UPDATE SET
       last_seen_at = MAX(units.last_seen_at, excluded.last_seen_at),
       -- A later, better-informed parse may upgrade an unknown class, but never
       -- downgrade a class we already recognised.
       kind = CASE WHEN units.kind = 'unknown' OR units.kind IS NULL THEN excluded.kind ELSE units.kind END,
       agency_type = CASE WHEN units.agency_type = 'other' OR units.agency_type IS NULL
                          THEN excluded.agency_type ELSE units.agency_type END`,
  ).run(
    unitId(parsed.designator),
    parsed.designator,
    parsed.agency,
    parsed.unitClass,
    seenAt.toISOString(),
    seenAt.toISOString(),
  );
  return parsed;
}

export function recordUnits(
  db: Database,
  raws: readonly string[],
  seenAt: Date,
  hints: { unitTypes?: Record<string, string | undefined>; source?: string | undefined } = {},
): ParsedUnit[] {
  const parsed: ParsedUnit[] = [];
  const run = db.transaction(() => {
    for (const raw of raws) {
      const unit = recordUnit(db, raw, seenAt, {
        unitType: hints.unitTypes?.[raw],
        source: hints.source,
      });
      if (unit) parsed.push(unit);
    }
  });
  run();
  return parsed;
}

/** Attach units to an incident, once each, keeping the earliest sighting. */
export function attachUnitsToIncident(
  db: Database,
  incidentId: string,
  designators: readonly string[],
  seenAt: Date,
): number {
  const insert = db.query(
    `INSERT INTO incident_units (incident_id, unit_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (incident_id, unit_id) DO UPDATE SET
       first_seen_at = MIN(incident_units.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(incident_units.last_seen_at, excluded.last_seen_at)`,
  );
  const run = db.transaction(() => {
    for (const designator of designators) {
      insert.run(incidentId, unitId(designator), seenAt.toISOString(), seenAt.toISOString());
    }
  });
  run();
  return designators.length;
}

export function unitsForIncident(db: Database, incidentId: string): (UnitRow & { first_seen_at: string })[] {
  return db
    .query<UnitRow, [string]>(
      `SELECT u.id, u.designator, u.agency_type, u.kind, iu.first_seen_at, iu.last_seen_at
         FROM incident_units iu JOIN units u ON u.id = iu.unit_id
        WHERE iu.incident_id = ?
        ORDER BY iu.first_seen_at, u.designator`,
    )
    .all(incidentId);
}

export function knownUnits(db: Database): UnitRow[] {
  return db.query<UnitRow, []>("SELECT * FROM units ORDER BY designator").all();
}
