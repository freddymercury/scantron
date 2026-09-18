/**
 * The two endpoints S-A6 asks every process to expose. Response builders rather than a
 * server, so the worker and the web app mount them on their own `Bun.serve` routes.
 */

import { healthHttpStatus, type HealthReport } from "./health.ts";
import { CONTENT_TYPE_PROMETHEUS, type Registry } from "./metrics.ts";

export function metricsResponse(registry: Registry): Response {
  return new Response(registry.render(), {
    headers: { "content-type": CONTENT_TYPE_PROMETHEUS, "cache-control": "no-store" },
  });
}

export function healthResponse(report: HealthReport): Response {
  return Response.json(report, {
    status: healthHttpStatus(report),
    headers: { "cache-control": "no-store" },
  });
}

export interface ObservabilityServerOptions {
  port: number;
  registry: Registry;
  /** Evaluated per request, so the answer is current rather than cached at boot. */
  health: () => HealthReport;
  /** Named in the log line the server emits when it starts. */
  service: string;
  onListening?: (url: string) => void;
}

/**
 * A worker has no HTTP server of its own, but S-A6 still wants `/metrics` and `/health`
 * from it. This is that server, and nothing else lives on it.
 */
export function serveObservability(options: ObservabilityServerOptions): {
  url: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: options.port,
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/metrics") return metricsResponse(options.registry);
      if (path === "/health") return healthResponse(options.health());
      return new Response("not found", { status: 404 });
    },
  });
  const url = server.url.toString();
  options.onListening?.(url);
  return { url, stop: () => server.stop(true) };
}
