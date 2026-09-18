/**
 * scantron web — server-rendered HTML from Bun.serve.
 *
 * ADR-002 amends PRD §34 and S-A1: no Next.js, React or MUI. The app shell arrives with
 * S-F1; this proves the server boots, serves a page, and does so under a CSP whose inline
 * scripts are nonce-allowed rather than blanket-allowed.
 */

import { SF_BBOX, SF_TIMEZONE } from "@scantron/sf-domain";

import { createNonce, escapeHtml, securityHeaders } from "./security.ts";

const PORT = Number(process.env.WEB_PORT ?? 3000);

function page(nonce: string): string {
  const bbox = `${SF_BBOX.west},${SF_BBOX.south} → ${SF_BBOX.east},${SF_BBOX.north}`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>scantron</title>
<h1>scantron</h1>
<p>San Francisco incident intelligence. Scaffold only — the app shell arrives with S-F1.</p>
<p>Timezone ${escapeHtml(SF_TIMEZONE)}; bbox ${escapeHtml(bbox)}.</p>
<script nonce="${nonce}">
  // Inline because the client runtime is ours and server-rendered; it runs only because
  // this nonce matches the one in this response's Content-Security-Policy.
  document.documentElement.dataset.ready = "true";
</script>
`;
}

export function handle(request: Request): Response {
  const path = new URL(request.url).pathname;

  if (path === "/") {
    const nonce = createNonce();
    return new Response(page(nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...securityHeaders(nonce),
      },
    });
  }

  if (path === "/healthz") {
    return Response.json({ status: "ok", service: "web" }, { headers: securityHeaders() });
  }

  return new Response("not found", { status: 404, headers: securityHeaders() });
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
