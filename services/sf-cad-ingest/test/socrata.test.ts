import { expect, test } from "bun:test";
import { SocrataError, buildUrl, createSocrataClient } from "../src/socrata.ts";

const host = "https://data.sf.gov";

function stubFetch(responses: (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    void init;
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next?.() ?? new Response("[]");
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

test("queries are built as SODA parameters", () => {
  const url = buildUrl(host, {
    dataset: "gnap-fj3t",
    where: "data_loaded_at > '2026-09-18T00:00:00.000'",
    order: "data_loaded_at ASC",
    limit: 500,
    offset: 1000,
  });
  expect(url).toContain("/resource/gnap-fj3t.json");
  const params = new URL(url).searchParams;
  expect(params.get("$where")).toBe("data_loaded_at > '2026-09-18T00:00:00.000'");
  expect(params.get("$order")).toBe("data_loaded_at ASC");
  expect(params.get("$limit")).toBe("500");
  expect(params.get("$offset")).toBe("1000");
});

test("the app token is sent when configured, so we are not on the anonymous quota", async () => {
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response("[]");
  }) as unknown as typeof fetch;

  await createSocrataClient({ host, appToken: "token123", fetchImpl }).query({ dataset: "x" });
  expect(headers["X-App-Token"]).toBe("token123");
});

test("429 and 5xx retry with backoff, then succeed", async () => {
  const slept: number[] = [];
  const { fetchImpl } = stubFetch([
    () => new Response("rate limited", { status: 429 }),
    () => new Response("boom", { status: 503 }),
    () => new Response(JSON.stringify([{ id: "1" }])),
  ]);

  const rows = await createSocrataClient({
    host,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    baseBackoffMs: 100,
  }).query<{ id: string }>({ dataset: "gnap-fj3t" });

  expect(rows).toEqual([{ id: "1" }]);
  expect(slept).toEqual([100, 200]);
});

test("a 400 is not retried — a bad query will not become good", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("bad query", { status: 400 });
  }) as unknown as typeof fetch;

  const client = createSocrataClient({ host, fetchImpl, sleep: async () => {} });
  await expect(client.query({ dataset: "gnap-fj3t" })).rejects.toThrow(SocrataError);
  expect(calls).toBe(1);
});

test("network failures retry and eventually give up rather than hanging", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  const client = createSocrataClient({ host, fetchImpl, sleep: async () => {}, maxRetries: 2 });
  await expect(client.query({ dataset: "gnap-fj3t" })).rejects.toThrow("ECONNRESET");
  expect(calls).toBe(3);
});

test("paging stops at a short page and never pages forever", async () => {
  const pages = [
    Array.from({ length: 2 }, (_, i) => ({ id: `a${i}` })),
    Array.from({ length: 2 }, (_, i) => ({ id: `b${i}` })),
    [{ id: "c0" }],
  ];
  let call = 0;
  const fetchImpl = (async () => new Response(JSON.stringify(pages[call++] ?? []))) as unknown as typeof fetch;

  const rows = await createSocrataClient({ host, fetchImpl }).queryAll<{ id: string }>({
    dataset: "gnap-fj3t",
    pageSize: 2,
  });
  expect(rows).toHaveLength(5);
  expect(call).toBe(3);
});

test("keyset paging pages by (time, id) and never repeats a row", async () => {
  // Two batches share one publication timestamp, which is exactly the case offset paging
  // gets wrong on the live feed.
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `id${i}`,
    data_loaded_at: i < 3 ? "2026-09-18T06:15:37.632" : "2026-09-18T06:20:00.000",
  }));
  const wheres: (string | null)[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const params = new URL(String(input)).searchParams;
    wheres.push(params.get("$where"));
    const limit = Number(params.get("$limit"));
    const where = params.get("$where") ?? "";

    const after = /\(data_loaded_at > '([^']+)' OR \(data_loaded_at = '[^']+' AND id > '([^']+)'\)\)/.exec(where);
    const remaining = after
      ? rows.filter(
          (row) =>
            row.data_loaded_at > (after[1] as string) ||
            (row.data_loaded_at === after[1] && row.id > (after[2] as string)),
        )
      : rows;
    return new Response(JSON.stringify(remaining.slice(0, limit)));
  }) as unknown as typeof fetch;

  const all = await createSocrataClient({ host, fetchImpl }).queryKeyset<{
    id: string;
    data_loaded_at: string;
  }>({ dataset: "gnap-fj3t", timeField: "data_loaded_at", idField: "id", pageSize: 2 });

  expect(all.map((row) => row.id)).toEqual(["id0", "id1", "id2", "id3", "id4"]);
  expect(new Set(all.map((row) => row.id)).size).toBe(5);
  expect(wheres[0]).toBeNull();
  expect(wheres[1]).toContain("data_loaded_at = '2026-09-18T06:15:37.632' AND id > 'id1'");
});

test("a quote in a keyset value cannot break out of the SODA query", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const where = new URL(String(input)).searchParams.get("$where");
    if (where) seen.push(where);
    return new Response(
      JSON.stringify(seen.length === 0 ? [{ id: "o'brien", t: "2026-09-18T00:00:00.000" }] : []),
    );
  }) as unknown as typeof fetch;

  await createSocrataClient({ host, fetchImpl }).queryKeyset({
    dataset: "x",
    timeField: "t",
    idField: "id",
    pageSize: 1,
  });
  expect(seen[0]).toContain("id > 'o''brien'");
});
