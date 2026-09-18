/**
 * incident-correlator — correlates observations into incidents
 *
 * No-op process. The work loop arrives with S-D1; S-A1 only proves it boots,
 * logs, and shuts down cleanly on a signal.
 */

const SERVICE = "incident-correlator";

export function describeService(): { service: string; implementedBy: string } {
  return { service: SERVICE, implementedBy: "S-D1" };
}

export function main(): void {
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, event, ...fields }));
  };

  log("started", { pid: process.pid, implementedBy: "S-D1" });

  const stop = (signal: string) => () => {
    log("stopping", { signal });
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  // Keep the process alive without busy-waiting, so `bun run dev` behaves like the
  // real worker will.
  setInterval(() => {}, 1 << 30);
}

if (import.meta.main) main();
