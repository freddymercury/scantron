import { expect, test } from "bun:test";
import { createLogger, errorMessage, LOG_FIELDS, newRequestId, redact, type LogLine } from "../src/index.ts";

function collect(): { lines: LogLine[]; sink: (line: LogLine) => void } {
  const lines: LogLine[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

test("a log line carries the PRD §40 fields", () => {
  const { lines, sink } = collect();
  const log = createLogger({ sink, level: "debug", context: { processor: "sf-cad-ingest" } });

  log.info("observation.normalized", {
    request_id: "req_1",
    observation_id: "obs_1",
    incident_id: "inc_1",
    source: "sf_police_cad",
    processing_time_ms: 12,
    result: "ok",
  });

  const [line] = lines;
  expect(line?.event).toBe("observation.normalized");
  expect(line?.level).toBe("info");
  expect(line?.processor).toBe("sf-cad-ingest");
  expect(line?.request_id).toBe("req_1");
  expect(line?.observation_id).toBe("obs_1");
  expect(line?.incident_id).toBe("inc_1");
  expect(line?.source).toBe("sf_police_cad");
  expect(line?.processing_time_ms).toBe(12);
  expect(line?.result).toBe("ok");
  expect(typeof line?.ts).toBe("string");
});

test("free-text and address detail cannot be logged, even when passed", () => {
  const { lines, sink } = collect();
  const log = createLogger({ sink });

  log.info("observation.ingested", {
    observation_id: "obs_1",
    text: "RP states suspect is her neighbour at 123 Secret Ln apt 4",
    address: "123 Secret Ln",
    lat: 37.7793,
    lng: -122.4193,
    caller_phone: "+1-415-555-0100",
  } as never);

  const serialized = JSON.stringify(lines[0]);
  expect(serialized).not.toContain("Secret Ln");
  expect(serialized).not.toContain("555-0100");
  expect(serialized).not.toContain("37.7793");
  expect(serialized).not.toContain("caller_phone");
  // The line says something was dropped, without saying what.
  expect(lines[0]?.dropped_fields).toBe(5);
});

test("redact reports what it kept and how much it dropped", () => {
  const { kept, dropped } = redact({ request_id: "req_1", text: "secret" } as never);
  expect(kept).toEqual({ request_id: "req_1" });
  expect(dropped).toEqual(["text"]);
  expect(LOG_FIELDS).toContain("request_id");
  expect(LOG_FIELDS).not.toContain("text");
});

test("levels filter as expected", () => {
  const { lines, sink } = collect();
  const log = createLogger({ sink, level: "warn" });
  log.debug("a");
  log.info("b");
  log.warn("c");
  log.error("d");
  expect(lines.map((line) => line.event)).toEqual(["c", "d"]);
});

test("child loggers inherit context, which is how request_id travels", () => {
  const { lines, sink } = collect();
  const root = createLogger({ sink, context: { processor: "worker" } });
  const child = root.child({ request_id: "req_7" });
  const grandchild = child.child({ observation_id: "obs_3" });

  grandchild.info("job.completed", { result: "ok" });
  expect(lines[0]).toMatchObject({
    processor: "worker",
    request_id: "req_7",
    observation_id: "obs_3",
    result: "ok",
  });
  // The parent is untouched.
  root.info("tick");
  expect(lines[1]?.request_id).toBeUndefined();
});

test("request ids are unique and prefixed", () => {
  const ids = new Set(Array.from({ length: 100 }, newRequestId));
  expect(ids.size).toBe(100);
  for (const id of ids) expect(id.startsWith("req_")).toBe(true);
});

test("errorMessage normalizes anything throwable", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("boom")).toBe("boom");
  expect(errorMessage(404)).toBe("404");
});
