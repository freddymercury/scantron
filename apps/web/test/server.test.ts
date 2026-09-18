import { expect, test } from "bun:test";
import { handle } from "../src/server.ts";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../src/security.ts";

const get = (path: string) => handle(new Request(`http://localhost${path}`));

test("serves the index page", async () => {
  const res = get("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("scantron");
});

test("healthz reports ok", async () => {
  expect(await get("/healthz").json()).toEqual({ status: "ok", service: "web" });
});

test("unknown paths 404", () => {
  expect(get("/nope").status).toBe(404);
});

test("every inline script carries the nonce from this response's CSP", async () => {
  const res = get("/");
  const policy = res.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toBeTruthy();

  const body = await res.text();
  const scripts = [...body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? "");
  expect(scripts.length).toBeGreaterThan(0);
  for (const attributes of scripts) {
    expect(attributes).toContain(`nonce="${nonce}"`);
  }
});

test("the nonce is fresh on every response", () => {
  const first = get("/").headers.get("content-security-policy");
  const second = get("/").headers.get("content-security-policy");
  expect(first).not.toBe(second);
  expect(createNonce()).not.toBe(createNonce());
});

test("the policy allows no unsafe inline or remote origins", () => {
  const policy = get("/").headers.get("content-security-policy") ?? "";
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  expect(policy).not.toContain("*");
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("base-uri 'none'");
});

test("security headers are on every response, CSP only where HTML is", () => {
  for (const path of ["/", "/healthz", "/nope"]) {
    const headers = get(path).headers;
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-frame-options")).toBe("DENY");
  }
  expect(get("/healthz").headers.get("content-security-policy")).toBeNull();
});

test("nonces are unguessable enough to be worth having", () => {
  const nonces = new Set(Array.from({ length: 200 }, createNonce));
  expect(nonces.size).toBe(200);
  for (const nonce of nonces) expect(nonce.length).toBeGreaterThanOrEqual(16);
});

test("interpolated text is escaped", () => {
  expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
  expect(contentSecurityPolicy("abc")).toContain("'nonce-abc'");
});

test("metrics are exposed in Prometheus text format", async () => {
  const res = get("/metrics");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toContain("scantron_step_duration_seconds");
});

test("health reports queue depth and stays 200 with no sources configured", async () => {
  const res = get("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok", sources: [], queue: { pending: 0 } });
});

test("health goes non-200 when a configured source has gone silent", async () => {
  const { createTestDatabase } = await import("@scantron/database/testing");
  const { createAppMetrics } = await import("@scantron/observability");
  const { createHandler } = await import("../src/server.ts");

  const db = createTestDatabase();
  db.query(
    `INSERT INTO source_configuration (source, dataset_id, poll_seconds, updated_at, last_success_at, consecutive_failures)
     VALUES ('sf_police_cad', 'gnap-fj3t', 60, '2026-09-18T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 3)`,
  ).run();

  const handler = createHandler({ db, metrics: createAppMetrics() });
  const res = handler(new Request("http://localhost/health"));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: "degraded" });
  db.close();
});
