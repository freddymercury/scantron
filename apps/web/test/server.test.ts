import { expect, test } from "bun:test";
import { handle } from "../src/server.ts";

test("serves the index page", async () => {
  const res = handle(new Request("http://localhost/"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("scantron");
});

test("healthz reports ok", async () => {
  const res = handle(new Request("http://localhost/healthz"));
  expect(await res.json()).toEqual({ status: "ok", service: "web" });
});

test("unknown paths 404", () => {
  expect(handle(new Request("http://localhost/nope")).status).toBe(404);
});
