/**
 * The ask-box parse suite (S-H4). Every case is a question shaped like one a person would
 * actually type; a parse regression here fails CI, which is the point of Tier 1 being
 * deterministic.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "@scantron/database/testing";
import { upsertObservation } from "@scantron/database";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import { runAsk } from "../src/ask/answer.ts";
import { describeQuery, parseNumericWindow, parseQuestion } from "../src/ask/parse.ts";
import { renderAnswer } from "../src/ask/render.ts";
import { validateAskQuery } from "../src/ask/schema.ts";

interface Case {
  q: string;
  area: string | null;
  category: string | null;
  minutes: number;
  intent: string;
}

const CASES = JSON.parse(
  readFileSync(new URL("./fixtures/ask-questions.json", import.meta.url).pathname, "utf8"),
) as Case[];

const AREAS = [
  "Mission",
  "Tenderloin",
  "South of Market",
  "Bayview Hunters Point",
  "Sunset/Parkside",
  "Inner Sunset",
  "Outer Richmond",
  "Chinatown",
  "North Beach",
  "Financial District",
];

test("the question corpus is real-shaped and sizeable", () => {
  expect(CASES.length).toBeGreaterThanOrEqual(60);
});

test("every question in the corpus parses to the expected query", () => {
  const wrong: string[] = [];
  for (const testCase of CASES) {
    const parsed = parseQuestion(testCase.q, { knownAreas: AREAS });
    const actual = {
      area: parsed.area ?? null,
      category: parsed.categoryLabel ?? null,
      minutes: parsed.windowMinutes,
      intent: parsed.intent,
    };
    const expected = {
      area: testCase.area,
      category: testCase.category,
      minutes: testCase.minutes,
      intent: testCase.intent,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      wrong.push(`${testCase.q}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
    }
  }
  expect(wrong).toEqual([]);
});

test("Tier 1 coverage is total except for one named gap", () => {
  const unresolved = CASES.map((testCase) => ({
    q: testCase.q,
    words: parseQuestion(testCase.q, { knownAreas: AREAS }).unresolved,
  })).filter((entry) => entry.words.length > 0);

  // A word left over means the grammar does not know something the reader said. The only
  // ones here are landmarks — "union square", "the embarcadero" — which are real places
  // people ask about and which the grammar resolves to neighborhoods, not points. They are
  // listed rather than hidden so the gap stays visible in the coverage number.
  expect(unresolved.map((entry) => entry.q).sort()).toEqual([
    "crashes on the embarcadero today",
    "thefts in union square today",
  ]);
  const covered = (CASES.length - unresolved.length) / CASES.length;
  expect(covered).toBeGreaterThan(0.95);
});

test("numeric windows parse in the units people type", () => {
  expect(parseNumericWindow("last 90 min")).toMatchObject({ minutes: 90 });
  expect(parseNumericWindow("past 2 hrs")).toMatchObject({ minutes: 120 });
  expect(parseNumericWindow("in the last three days")).toMatchObject({ minutes: 4320 });
  expect(parseNumericWindow("last 2 weeks")).toMatchObject({ minutes: 20160 });
  expect(parseNumericWindow("6 months")).toMatchObject({ minutes: 259200 });
  expect(parseNumericWindow("no time here")).toBeUndefined();
});

test("a question we cannot answer is detected and named, not guessed at", () => {
  for (const question of [
    "is it safe to walk home in the tenderloin",
    "was anyone hurt in the mission today",
    "who was arrested in soma last night",
    "why did that fire start",
  ]) {
    const parsed = parseQuestion(question, { knownAreas: AREAS });
    expect(`${question}: ${Boolean(parsed.unanswerable)}`).toBe(`${question}: true`);
  }
  // And an answerable one is not swept up with them.
  expect(parseQuestion("fires in the mission today", { knownAreas: AREAS }).unanswerable).toBeUndefined();
});

test("nonsense is reported as nonsense rather than answered", () => {
  const parsed = parseQuestion("blorp the zibzab in wimwam", { knownAreas: AREAS });
  expect(parsed.unresolved).toEqual(["blorp", "zibzab", "wimwam"]);
  expect(parsed.area).toBeUndefined();
});

test("the parsed query passes the structured-query gate a Tier 2 model would have to", () => {
  for (const testCase of CASES.slice(0, 10)) {
    const result = validateAskQuery(parseQuestion(testCase.q, { knownAreas: AREAS }));
    expect(`${testCase.q}: ${result.ok}`).toBe(`${testCase.q}: true`);
  }

  // A model that invents a field or an area type gets it dropped or rejected, not honoured.
  const smuggled = validateAskQuery({
    intent: "list",
    windowMinutes: 60,
    windowLabel: "the last hour",
    types: [],
    rawCodes: [],
    unresolved: [],
    question: "x",
    answerText: "Here is a nice sentence I wrote for the user",
  });
  expect(smuggled.ok).toBe(true);
  if (smuggled.ok) expect(Object.keys(smuggled.value)).not.toContain("answerText");

  expect(validateAskQuery({ intent: "explain", windowMinutes: 60 }).ok).toBe(false);
});

test("the interpretation is always stated back", () => {
  expect(describeQuery(parseQuestion("car break ins in soma last week", { knownAreas: AREAS }))).toBe(
    "car break-ins · South of Market · the last week",
  );
  expect(describeQuery(parseQuestion("fires", { knownAreas: AREAS }))).toBe(
    "fires · all of San Francisco · the last 3 hours",
  );
});

function seedAsk() {
  const db = createTestDatabase();
  const base: Observation = {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "1",
    occurredAt: new Date(Date.now() - 20 * 60_000),
    ingestedAt: new Date(),
    type: "weapon",
    rawType: "221",
    subtype: "PERSON W/GUN",
    priority: "A",
    priorityRank: 1,
    confidence: 0.6,
    location: { normalized: "16th St & Mission St", latitude: 37.765, longitude: -122.419, neighborhood: "Mission" },
  };
  upsertObservation(db, observationToRow(base));
  upsertObservation(
    db,
    observationToRow({
      ...base,
      id: "obs_2",
      sourceRecordId: "2",
      type: "theft",
      rawType: "852",
      subtype: "AUTO BOOST / STRIP",
      priority: "C",
      priorityRank: 4,
    }),
  );
  upsertObservation(
    db,
    observationToRow({
      ...base,
      id: "obs_3",
      sourceRecordId: "3",
      source: "sf_fire_cad",
      type: "medical",
      subtype: "Medical Incident",
      units: ["M18", "E07", "T07"],
      priorityRank: 2,
    }),
  );
  return db;
}

test("a real question returns a real answer over the data", () => {
  const db = seedAsk();
  const query = parseQuestion("car break ins in the mission in the last 2 hours", { knownAreas: ["Mission"] });
  const answer = runAsk(db, query);

  expect(answer.total).toBe(1);
  expect(answer.rows[0]?.raw_type).toBe("852");
  const html = renderAnswer(answer);
  expect(html).toContain("<b>1 car break-ins</b> in Mission in the last 2 hours");
  expect(html).toContain("AUTO BOOST / STRIP");
  db.close();
});

test("'most interesting' ranks by dispatch signals and says which ones", () => {
  const db = seedAsk();
  const query = parseQuestion("most interesting thing in the mission in the last 2 hours", {
    knownAreas: ["Mission"],
  });
  const answer = runAsk(db, query);

  expect(answer.ranked[0]?.row.id).toBe("obs_1");
  const reasons = answer.ranked[0]?.reasons.join(" ") ?? "";
  expect(reasons).toContain("weapon call");
  expect(reasons).toContain("priority 1");
  // The multi-unit fire/EMS response ranks too, and says why.
  expect(answer.ranked.map((item) => item.row.id)).toContain("obs_3");
  expect(answer.ranked.find((item) => item.row.id === "obs_3")?.reasons.join(" ")).toContain("3 units responded");

  const html = renderAnswer(answer);
  // The ranking explains itself and refuses the inference nobody should draw from it.
  expect(html).toContain("not of harm");
  db.close();
});

test("an empty result says what that does and does not mean", () => {
  const db = seedAsk();
  const query = parseQuestion("fires in the mission in the last 2 hours", { knownAreas: ["Mission"] });
  const html = renderAnswer(runAsk(db, query));

  expect(html).toContain("No fires were reported in Mission in the last 2 hours");
  expect(html).toContain("not that nothing happened");
  expect(html).toContain("~30 minute delay");
  db.close();
});

test("an unanswerable question is refused in the answer, not just in the parse", () => {
  const db = seedAsk();
  const query = parseQuestion("is it safe in the mission tonight", { knownAreas: ["Mission"] });
  const html = renderAnswer(runAsk(db, query));

  expect(html).toContain("This data cannot answer that");
  expect(html).toContain("dispatch volume is not danger");
  expect(html).toContain("call 911");
  db.close();
});

test("a count answer lists the incidents behind the number, each drillable", async () => {
  const { applyDecision } = await import("@scantron/correlation");
  const db = seedAsk();

  for (const row of db
    .query<
      { id: string; source: string; occurred_at: string; type: string | null; lat: number | null; lng: number | null; neighborhood: string | null; location_normalized: string | null; units: string | null },
      []
    >(
      `SELECT id, source, occurred_at, type, lat, lng, neighborhood, location_normalized, units
         FROM observations ORDER BY occurred_at`,
    )
    .all()) {
    applyDecision(db, {
      observation: {
        id: row.id,
        source: row.source,
        occurredAt: new Date(row.occurred_at),
        ...(row.lat === null ? {} : { lat: row.lat }),
        ...(row.lng === null ? {} : { lng: row.lng }),
        ...(row.neighborhood === null ? {} : { neighborhood: row.neighborhood }),
        ...(row.type === null ? {} : { type: row.type }),
        ...(row.location_normalized === null ? {} : { locationCanonical: row.location_normalized }),
        ...(row.units === null ? {} : { units: JSON.parse(row.units) as string[] }),
      },
    });
  }

  const query = parseQuestion("how many calls in the mission in the last 2 hours", {
    knownAreas: ["Mission"],
  });
  const answer = runAsk(db, query);
  expect(answer.incidents.length).toBeGreaterThan(0);
  expect(answer.incidentTotal).toBe(answer.incidents.length);

  const html = renderAnswer(answer);
  expect(html).toContain("<h3>incidents");
  expect(html).toContain(`/internal/incident/${answer.incidents[0]!.id}`);
  // The type mix narrows the same question rather than being dead text.
  expect(html).toContain("category=weapon");
  db.close();
});

test("timestamps carry the original instant for the browser to localize", async () => {
  const { timeTag } = await import("../src/internal/time.ts");

  const absolute = timeTag("2026-09-21T17:27:49.702Z");
  expect(absolute).toContain('datetime="2026-09-21T17:27:49.702Z"');
  expect(absolute).toContain('title="2026-09-21T17:27:49.702Z"');
  expect(absolute).toContain('data-rel="0"');
  // Without scripting the ISO string is still the visible text — less friendly, not wrong.
  expect(absolute).toContain(">2026-09-21T17:27:49.702Z</time>");

  const relative = timeTag("2026-09-21T17:27:49.702Z", { text: "12 min ago" });
  expect(relative).toContain('data-rel="1"');
  expect(relative).toContain(">12 min ago</time>");
});

test("a question with no category in the taxonomy leads with the search, not a total", () => {
  const db = seedAsk();
  const query = parseQuestion("prostitution in the last 2 hours", { knownAreas: ["Mission"] });
  const answer = runAsk(db, query);

  // Nothing in the taxonomy covers it, so the structured half is "all activity".
  expect(query.types).toEqual([]);
  expect(query.unresolved).toContain("prostitution");

  answer.search = {
    reranked: true,
    hits: [
      {
        row: { ...answer.rows[0]!, subtype: "Solicits For Act Of Prostitution" },
        lexicalScore: 1,
        via: "keyword" as const,
        finalScore: 1,
        relevanceLabel: "Exactly what they asked about",
      },
    ],
    latencyMs: 100,
  };

  const html = renderAnswer(answer);
  const searchAt = html.indexOf("which the grammar did not recognise");
  const totalAt = html.indexOf("of every kind");
  expect(searchAt).toBeGreaterThan(0);
  // The two records that matched come before the number that did not answer anything.
  expect(searchAt).toBeLessThan(totalAt);
  expect(html).toContain("No category in this taxonomy covers");
  db.close();
});

test("a subject with no category is reachable by the agency's own codes", async () => {
  const { expandQuery } = await import("../src/ask/expand.ts");
  const db = seedAsk();

  for (const question of ["prostitution", "sex work", "soliciting", "pandering"]) {
    const expansion = expandQuery(db, question);
    // No type: every product type broad enough to hold these is a worse answer than none.
    expect(expansion.types).toEqual([]);
    // SFPD's own codes instead — `647B` on dispatch, the `13xxx` family in reports.
    expect(expansion.rawCodes).toContain("647B");
    expect(expansion.rawCodes).toContain("13060");
    expect(expansion.matched).toContain("prostitution-related calls and reports");
  }

  const trafficking = expandQuery(db, "human trafficking");
  expect(trafficking.types).toEqual([]);
  expect(trafficking.rawCodes).toContain("13045");
  db.close();
});

test("'sex' does not prefix-match 'sexual'", async () => {
  const { toMatchQuery, EXACT_TERMS } = await import("../src/ask/search.ts");

  // Answering a question about sex work with sexual assault calls is the worst failure
  // this search can produce. Measured live: the top four hits were SEXUAL ASSAULT ADULT.
  expect(toMatchQuery("sex work")).toBe('"sex" OR "work"*');
  expect(EXACT_TERMS.has("sex")).toBe(true);

  // Prefix matching still earns its place everywhere else.
  expect(toMatchQuery("gun")).toBe('"gun"*');
  expect(toMatchQuery("sexual assault")).toBe('"sexual"* OR "assault"*');
});
