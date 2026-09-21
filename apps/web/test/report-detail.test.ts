/**
 * Reading a report as itself (S-I2). The block exists because the observation page was
 * built for a dispatch call and a report has none of a call's fields — and four of its own.
 */

import { expect, test } from "bun:test";

import { reportDetail } from "../src/internal/report-detail.ts";

const PAYLOAD = JSON.stringify({
  incident_description: "Solicits For Act Of Prostitution",
  incident_category: "Prostitution",
  incident_subcategory: "Prostitution",
  incident_code: "13060",
  resolution: "Cite or Arrest Adult",
  report_type_description: "Initial",
  incident_number: "260550619",
  cad_number: "262630453",
  incident_datetime: "2026-09-20T04:19:00.000",
  report_datetime: "2026-09-20T04:19:00.000",
});

test("a report shows what a call cannot", () => {
  const html = reportDetail("sf_police_report", PAYLOAD);
  expect(html).toContain("Solicits For Act Of Prostitution");
  expect(html).toContain("Cite or Arrest Adult");
  expect(html).toContain("260550619");
  expect(html).toContain("262630453");
  expect(html).toContain("by an officer");
  expect(html).toContain("same day");
  // The ceiling is stated on the page, not just in a comment.
  expect(html).toContain("no narrative in this dataset");
});

test("a repeated subcategory is not shown twice", () => {
  expect(reportDetail("sf_police_report", PAYLOAD)).not.toContain("subcategory");

  const distinct = reportDetail(
    "sf_police_report",
    JSON.stringify({ incident_category: "Assault", incident_subcategory: "Aggravated Assault" }),
  );
  expect(distinct).toContain("Aggravated Assault");
});

test("case status is explained without becoming a claim about a person", () => {
  const open = reportDetail("sf_police_report", JSON.stringify({ resolution: "Open or Active" }));
  expect(open).toContain("no outcome recorded");
  expect(open).toContain("not any person");

  const unfounded = reportDetail("sf_police_report", JSON.stringify({ resolution: "Unfounded" }));
  expect(unfounded).toContain("did not occur");
});

test("an unjoinable report says so rather than staying quiet", () => {
  const online = reportDetail(
    "sf_police_report",
    JSON.stringify({ filed_online: true, incident_description: "Theft, From Locked Vehicle" }),
  );
  expect(online).toContain("online by the public");
  expect(online).toContain("never matched to an incident by any other means");
});

test("a dispatch call gets no report block at all", () => {
  expect(reportDetail("sf_police_cad", PAYLOAD)).toBe("");
  expect(reportDetail("sf_police_report", undefined)).toBe("");
});
