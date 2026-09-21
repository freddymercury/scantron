/**
 * What the dispatch record actually says, beyond the fields the pipeline normalizes.
 *
 * Normalization keeps what every source has in common — a type, a place, a time, a unit
 * list. That is what makes correlation possible and it is deliberately lossy. The metadata
 * blob keeps the rest, and the rest is where an incident stops being a row and starts
 * being an event: which engine arrived first and how long it took, whether an officer came
 * across this themselves or was called, and whether the call turned out to be something
 * other than what was reported.
 *
 * Everything here is structured fields read through templates. None of these feeds carries
 * narrative text — there are no call notes, no officer remarks, nothing a person wrote in
 * a sentence — so "colour" has to come from structure, timing and history. That is a fact
 * about the source, not a gap in this file (docs/01).
 */

import { resolutionReason } from "@scantron/correlation";
import { parseSfTimestamp } from "@scantron/sf-domain";

export interface UnitResponse {
  unit: string;
  /** ENGINE, TRUCK, MEDIC, CHIEF, … as the agency classifies its own apparatus. */
  unitType: string | undefined;
  dispatch: string | undefined;
  response: string | undefined;
  onScene: string | undefined;
  available: string | undefined;
  /** Dispatch → on scene, in milliseconds, when both ends are present. */
  toSceneMs: number | undefined;
}

interface RawUnitTimestamps {
  [unit: string]: {
    dispatch?: string;
    response?: string;
    on_scene?: string;
    available?: string;
    unit_type?: string;
  };
}

/**
 * The agency publishes these as **naive San Francisco local time**, exactly like every
 * other timestamp in these feeds (docs/01). Read as UTC they are wrong by seven or eight
 * hours, so they go through the same parser as the rest of the pipeline before anything
 * displays them.
 */
function iso(value: unknown): string | undefined {
  const raw = plain(value);
  return raw === undefined ? undefined : parseSfTimestamp(raw)?.toISOString();
}

/** A string field, untouched — `unit_type` is a word, not a time. */
function plain(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** "4 min 52 s", "38 s" — the unit a reader can hold in their head. */
export function elapsed(fromIso: string | undefined, toIso: string | undefined): string | undefined {
  if (!fromIso || !toIso) return undefined;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * Per-unit choreography, ordered by who got there first.
 *
 * SFFD and SFEMS publish this on **100%** of records and an on-scene time on 93.5% of them
 * (measured over 3,925 live records), which makes it the richest thing in the feed that
 * nothing was reading.
 */
export function unitResponses(metadata: Record<string, unknown> | undefined): UnitResponse[] {
  const raw = metadata?.["unit_timestamps"];
  if (!raw || typeof raw !== "object") return [];

  const responses = Object.entries(raw as RawUnitTimestamps).map(([unit, times]) => {
    const dispatch = iso(times.dispatch);
    const onScene = iso(times.on_scene);
    const toScene = dispatch && onScene ? Date.parse(onScene) - Date.parse(dispatch) : Number.NaN;
    return {
      unit,
      unitType: plain(times.unit_type),
      dispatch,
      response: iso(times.response),
      onScene,
      available: iso(times.available),
      toSceneMs: Number.isFinite(toScene) && toScene >= 0 ? toScene : undefined,
    };
  });

  return responses.sort((a, b) => {
    if (a.onScene && b.onScene) return a.onScene.localeCompare(b.onScene);
    if (a.onScene) return -1;
    if (b.onScene) return 1;
    return a.unit.localeCompare(b.unit);
  });
}

/** The first unit to report on scene, which is the number a reader actually wants. */
export function firstOnScene(responses: readonly UnitResponse[]): UnitResponse | undefined {
  return responses.find((response) => response.onScene !== undefined);
}

export interface RecordFact {
  label: string;
  value: string;
  /** Set when the fact is unusual enough to deserve the reader's eye. */
  notable?: boolean;
}

const DISPOSITION_WORDS: Readonly<Record<string, string>> = {
  nothing_found: "closed with nothing found",
  report_taken: "closed with a report taken",
  enforcement: "closed with a citation or an arrest",
  handled: "closed as handled at the scene",
  referred: "referred elsewhere",
  unknown: "closed without a recorded outcome",
};

/**
 * The facts a dispatch record carries that the normalized columns drop.
 *
 * Each one is here because it was measured to vary. `priority_original` vs
 * `priority_final` is **not** here: it differed on 0 of 4,000 police records, so a
 * "priority raised" line would be a feature that never fires.
 */
export function recordFacts(metadata: Record<string, unknown> | undefined): RecordFact[] {
  if (!metadata) return [];
  const text = (key: string): string | undefined => {
    const value = metadata[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const facts: RecordFact[] = [];

  // --- police ---------------------------------------------------------------
  if (text("onview_flag") === "Y") {
    facts.push({
      label: "how it came in",
      value: "an officer came across this themselves — it was not phoned in",
      notable: true,
    });
  }

  const originalType = text("call_type_original_desc");
  const finalType = text("call_type_final_desc");
  if (originalType && finalType && originalType !== finalType) {
    facts.push({
      label: "changed en route",
      value: `reported as ${originalType}, closed as ${finalType}`,
      notable: true,
    });
  }

  const district = text("police_district");
  if (district) facts.push({ label: "police district", value: district });

  // --- fire and EMS ---------------------------------------------------------
  const group = text("call_type_group");
  if (group) {
    facts.push({
      label: "call group",
      value: group,
      notable: group.toLowerCase().includes("life-threatening"),
    });
  }

  if (metadata["als_unit"] === true) {
    facts.push({ label: "medical", value: "an advanced life support unit was assigned" });
  }

  const alarms = Number(text("number_of_alarms") ?? "1");
  if (Number.isFinite(alarms) && alarms > 1) {
    facts.push({ label: "alarms", value: `${alarms}-alarm response`, notable: true });
  }

  const battalion = text("battalion");
  const station = text("station_area");
  if (battalion || station) {
    facts.push({
      label: "station",
      value: [battalion ? `battalion ${battalion}` : "", station ? `station ${station}` : ""]
        .filter(Boolean)
        .join(" · "),
    });
  }

  // --- both -----------------------------------------------------------------
  const supervisor = text("supervisor_district");
  if (supervisor) {
    facts.push({ label: "supervisor district", value: supervisor.replace(/\.0$/, "") });
  }

  const disposition = text("disposition") ?? text("call_final_disposition");
  if (disposition) {
    const reason = resolutionReason(disposition);
    const words = DISPOSITION_WORDS[reason] ?? DISPOSITION_WORDS.unknown!;
    facts.push({
      label: "outcome",
      value: `${words} (${disposition})`,
      notable: reason === "nothing_found",
    });
  }

  return facts;
}
