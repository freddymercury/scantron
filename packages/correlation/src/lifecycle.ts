/**
 * Incident status (S-D4).
 *
 * The rule that shapes this file, from PRD §19: **the system must not invent a resolution
 * state.** An incident becomes `resolved` only when an agency says so — a `close_datetime`
 * with a disposition. Silence means `unknown`, which is a real answer and the one the data
 * supports; it never means finished.
 *
 * Every transition is driven by the agency's own timestamps, which docs/01 verified are
 * there: dispatch and enroute on 100% of calls, on-scene on 84%, close on 83%.
 */

import type { IncidentStatus } from "@scantron/incident-schema";
import { parseSfTimestamp } from "@scantron/sf-domain";

export type ResolutionReason =
  | "nothing_found"
  | "report_taken"
  | "enforcement"
  | "handled"
  | "referred"
  | "unknown";

/**
 * SFPD dispositions, observed live (docs/01 §2). ~20% of calls resolve to
 * explicitly-nothing-found, which is a fact worth keeping rather than flattening into
 * "closed".
 */
export const DISPOSITION_REASONS: Readonly<Record<string, ResolutionReason>> = {
  GOA: "nothing_found", // gone on arrival
  UTL: "nothing_found", // unable to locate
  NOM: "nothing_found", // no merit
  ND: "nothing_found", // no disposition / nothing done
  REP: "report_taken",
  CIT: "enforcement",
  ARR: "enforcement",
  HAN: "handled",
  ADV: "handled",
  CAN: "nothing_found", // cancelled
  VOI: "nothing_found",
};

export function resolutionReason(disposition: string | null | undefined): ResolutionReason {
  if (!disposition) return "unknown";
  return DISPOSITION_REASONS[disposition.trim().toUpperCase()] ?? "unknown";
}

/** Ordered, so a status can be compared for regression. `unknown` sits outside the order. */
const PROGRESS: readonly IncidentStatus[] = ["reported", "dispatched", "active", "contained", "resolved"];

export function statusRank(status: IncidentStatus): number {
  const index = PROGRESS.indexOf(status);
  return index === -1 ? -1 : index;
}

/** The agency timestamps an observation carries, as ISO strings. */
export interface LifecycleSignals {
  receivedAt?: string | undefined;
  dispatchedAt?: string | undefined;
  enrouteAt?: string | undefined;
  onSceneAt?: string | undefined;
  closedAt?: string | undefined;
  disposition?: string | undefined;
  /** SFFD `call_final_disposition`, which uses its own words. */
  fireDisposition?: string | undefined;
}

export interface StatusDecision {
  status: IncidentStatus;
  /** Plain words, shown in the timeline entry this produces. */
  reason: string;
  /** Only ever set from an explicit source signal (S-D4). */
  resolvedAt?: string;
  resolution?: ResolutionReason;
  /** True when the decision would have moved the status backwards and was refused. */
  regressionBlocked?: boolean;
}

/**
 * `(currentStatus, signals) → nextStatus`, pure and total.
 *
 * Status never regresses except through an explicit correction (S-D7), because a later
 * record that happens to lack a timestamp is not evidence that an event un-happened.
 */
export function nextStatus(
  current: IncidentStatus,
  signals: LifecycleSignals,
  options: { allowRegression?: boolean } = {},
): StatusDecision {
  const proposed = statusFromSignals(signals);

  // A record that carries no lifecycle timestamps is silence, and silence is not evidence
  // that what we already knew stopped being true. Only the staleness sweep may move a
  // known status to `unknown`, and it does so on elapsed time, not on a missing field.
  if (proposed.status === "unknown" && current !== "unknown") {
    return {
      status: current,
      reason: `kept ${current}: this record carried no lifecycle timestamps`,
      regressionBlocked: true,
    };
  }

  if (
    !options.allowRegression &&
    statusRank(proposed.status) !== -1 &&
    statusRank(current) > statusRank(proposed.status)
  ) {
    return {
      status: current,
      reason: `kept ${current}: a later record reported only "${proposed.status}", which is not evidence the event went backwards`,
      regressionBlocked: true,
    };
  }
  return proposed;
}

function statusFromSignals(signals: LifecycleSignals): StatusDecision {
  // Closure is the only thing that resolves an incident, and it must be explicit.
  if (signals.closedAt) {
    const reason = resolutionReason(signals.disposition ?? signals.fireDisposition);
    return {
      status: "resolved",
      resolvedAt: signals.closedAt,
      resolution: reason,
      reason:
        reason === "nothing_found"
          ? `closed by the agency with disposition ${signals.disposition ?? signals.fireDisposition} — nothing found`
          : `closed by the agency${signals.disposition ? ` with disposition ${signals.disposition}` : ""}`,
    };
  }
  if (signals.onSceneAt) {
    return { status: "active", reason: "a unit reported on scene" };
  }
  if (signals.dispatchedAt || signals.enrouteAt) {
    return { status: "dispatched", reason: "units were dispatched" };
  }
  if (signals.receivedAt) {
    return { status: "reported", reason: "the call was received" };
  }
  return { status: "unknown", reason: "no lifecycle timestamps on this record" };
}

export interface StalenessOptions {
  /** Minutes of silence before an incident is no longer described as current. */
  defaultMinutes: number;
  /** Per type, because a structure fire runs for hours and a traffic stop does not. */
  byType: Readonly<Record<string, number>>;
}

export const DEFAULT_STALENESS: StalenessOptions = {
  defaultMinutes: 45,
  byType: { fire: 180, rescue: 180, hazard: 180, collision: 90, medical: 60 },
};

export function stalenessMinutes(type: string | null | undefined, options = DEFAULT_STALENESS): number {
  return (type ? options.byType[type] : undefined) ?? options.defaultMinutes;
}

/**
 * The fallback for the ~17% of calls that never get a `close_datetime`.
 *
 * It moves an incident to `unknown` and **never** to `resolved`: we do not know that it
 * ended, only that nobody has said anything for a while. PRD §19 is explicit that the
 * system must not invent a resolution state, and this is the exact place the temptation
 * arises.
 */
export function staleStatus(
  current: IncidentStatus,
  lastObservedAt: string,
  type: string | null | undefined,
  now: Date,
  options = DEFAULT_STALENESS,
): StatusDecision | undefined {
  if (current === "resolved" || current === "unknown") return undefined;

  const quietMinutes = (now.getTime() - Date.parse(lastObservedAt)) / 60_000;
  const limit = stalenessMinutes(type, options);
  if (quietMinutes < limit) return undefined;

  return {
    status: "unknown",
    reason: `no further reports for ${Math.round(quietMinutes)} minutes — status unknown, not resolved`,
  };
}

/**
 * Pull the lifecycle timestamps out of an observation's metadata.
 *
 * Both agencies publish them, under different names and — the part that has bitten this
 * codebase before — as naive San Francisco local time, so they go through the same parser
 * as everything else (docs/01: read as UTC they are wrong by 7 or 8 hours).
 */
export function signalsFromMetadata(metadata: Record<string, unknown> | null | undefined): LifecycleSignals {
  if (!metadata) return {};
  const at = (key: string): string | undefined => {
    const raw = metadata[key];
    if (typeof raw !== "string") return undefined;
    return parseSfTimestamp(raw)?.toISOString();
  };
  const text = (key: string): string | undefined => {
    const raw = metadata[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const signals: LifecycleSignals = {};
  const received = at("received_datetime") ?? at("received_dttm") ?? at("entry_datetime") ?? at("entry_dttm");
  if (received) signals.receivedAt = received;
  const dispatched = at("dispatch_datetime") ?? at("dispatch_dttm");
  if (dispatched) signals.dispatchedAt = dispatched;
  const enroute = at("enroute_datetime") ?? at("response_dttm");
  if (enroute) signals.enrouteAt = enroute;
  const onScene = at("onscene_datetime") ?? at("on_scene_dttm");
  if (onScene) signals.onSceneAt = onScene;
  // SFFD publishes `available_dttm` (the unit cleared), which is not the call closing, so
  // only an explicit close counts.
  const closed = at("close_datetime");
  if (closed) signals.closedAt = closed;

  const disposition = text("disposition");
  if (disposition) signals.disposition = disposition;
  const fireDisposition = text("call_final_disposition");
  if (fireDisposition) signals.fireDisposition = fireDisposition;
  return signals;
}
