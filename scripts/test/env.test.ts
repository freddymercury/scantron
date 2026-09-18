import { expect, test } from "bun:test";
import { checkEnv, ENV_VARS } from "../env.ts";

test("a clean environment with defaults has no problems", () => {
  expect(checkEnv({})).toEqual([]);
});

test("a missing required variable is named in the message", () => {
  const problems = checkEnv({}, [
    { name: "DATASF_APP_TOKEN", required: true, description: "Socrata app token" },
  ]);
  expect(problems).toHaveLength(1);
  expect(problems[0]?.name).toBe("DATASF_APP_TOKEN");
  expect(problems[0]?.message).toContain("DATASF_APP_TOKEN");
  expect(problems[0]?.message).toContain(".env.example");
});

test("non-numeric ports and poll intervals are rejected", () => {
  expect(checkEnv({ WEB_PORT: "http" }).map((p) => p.name)).toEqual(["WEB_PORT"]);
  expect(checkEnv({ INGEST_POLL_SECONDS: "0" }).map((p) => p.name)).toEqual(["INGEST_POLL_SECONDS"]);
  expect(checkEnv({ WEB_PORT: "3000", INGEST_POLL_SECONDS: "60" })).toEqual([]);
});

test("every documented variable appears in .env.example", async () => {
  const example = await Bun.file(new URL("../../.env.example", import.meta.url).pathname).text();
  for (const spec of ENV_VARS) {
    expect(example).toContain(`${spec.name}=`);
  }
});
