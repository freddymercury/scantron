/**
 * An SFPD incident report, read as itself rather than as a dispatch call (S-I2).
 *
 * The observation page was built for a call: agency code, priority, units, who else was
 * nearby. A report has none of those and has four things a call does not — what offence
 * was written up, how the case stands, whether the public filed it online, and how long
 * after the event it was written.
 *
 * It is worth being plain about the ceiling. This is the whole of a report: a code, a
 * description, a category, a resolution, a place and two times. There is no narrative, no
 * officer's account, nothing about what happened to anyone. Adding fields to this page does
 * not change that — the signal in this dataset is in the distribution, not the record.
 */

import { escapeHtml } from "../security.ts";
import { fact } from "./detail.ts";
import { timeTag } from "./time.ts";

const RESOLUTION_NOTES: Readonly<Record<string, string>> = {
  "open or active": "no outcome recorded — 78% of all reports sit here",
  "cite or arrest adult": "someone was cited or arrested",
  unfounded: "SFPD concluded the reported offence did not occur",
  "exceptional adult": "closed without charges for a reason outside SFPD's control",
};

export function reportDetail(source: string, payload: string | undefined): string {
  if (source !== "sf_police_report" || !payload) return "";
  const record = JSON.parse(payload) as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const resolution = text("resolution");
  const note = resolution ? RESOLUTION_NOTES[resolution.toLowerCase()] : undefined;
  const filedOnline = record["filed_online"] === true || text("filed_online") === "true";

  // How long after the event it was written up. This is the lag docs/01 measured at a
  // median of 2.0 days, per record.
  const happened = text("incident_datetime");
  const written = text("report_datetime");
  const lagDays =
    happened && written
      ? Math.round(((Date.parse(written) - Date.parse(happened)) / 86_400_000) * 10) / 10
      : undefined;

  return `<h2>the report</h2>
<div class="counters">
  ${fact("offence", text("incident_description"))}
  ${fact("category", text("incident_category"))}
  ${fact(
    "subcategory",
    text("incident_subcategory") === text("incident_category") ? null : text("incident_subcategory"),
  )}
  ${fact("offence code", text("incident_code"))}
  ${fact("case status", resolution)}
  ${fact("report type", text("report_type_description"))}
  ${fact("incident number", text("incident_number"))}
  ${fact("filed", filedOnline ? "online by the public (Coplogic)" : "by an officer")}
  ${fact(
    "written up",
    lagDays === undefined ? null : lagDays < 1 ? "same day" : `${lagDays} days later`,
  )}
</div>
${note ? `<p class="muted">${escapeHtml(resolution ?? "")}: ${escapeHtml(note)}.</p>` : ""}
<p class="muted">Case status describes the case file, not any person. This is the whole of what SFPD publishes per report — a code, a description, a category, a resolution, a place and two times. There is no narrative in this dataset.</p>
${
  text("cad_number")
    ? `<p class="muted">Written up from CAD call <code>${escapeHtml(text("cad_number") ?? "")}</code>, which is how it joined an incident rather than being guessed at.</p>`
    : `<p class="muted">No <code>cad_number</code>, so this report is stored unjoined and is never matched to an incident by any other means (S-I2).</p>`
}`;
}
