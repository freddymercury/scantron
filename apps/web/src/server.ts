/**
 * scantron web — server-rendered HTML from Bun.serve.
 *
 * ADR-002 amends PRD §34 and S-A1: no Next.js, React or MUI. The app shell arrives
 * with S-F1; S-A1 only proves the server boots and serves a page.
 */

import { SF_BBOX, SF_TIMEZONE } from "@scantron/sf-domain";

const PORT = Number(process.env.WEB_PORT ?? 3000);

function page(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>scantron</title>
<h1>scantron</h1>
<p>San Francisco incident intelligence. Scaffold only — the app shell arrives with S-F1.</p>
<p>Timezone ${SF_TIMEZONE}; bbox ${SF_BBOX.west},${SF_BBOX.south} → ${SF_BBOX.east},${SF_BBOX.north}.</p>
`;
}

export const routes = {
  "/": () => new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } }),
  "/healthz": () => Response.json({ status: "ok", service: "web" }),
} as const;

export function handle(request: Request): Response {
  const path = new URL(request.url).pathname;
  const route = (routes as Record<string, (() => Response) | undefined>)[path];
  return route ? route() : new Response("not found", { status: 404 });
}

export function main(): void {
  const server = Bun.serve({ port: PORT, fetch: handle });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "web",
      event: "listening",
      url: server.url.toString(),
    }),
  );
}

if (import.meta.main) main();
