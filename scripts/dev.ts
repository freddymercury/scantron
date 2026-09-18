/**
 * `bun run dev` — web + workers together, with hot reload, in one terminal.
 *
 * Output from each child is prefixed with its name. Ctrl-C stops all of them.
 */

const TARGETS = [
  { name: "web", cwd: "apps/web", entry: "src/server.ts" },
  { name: "ingest", cwd: "services/sf-cad-ingest", entry: "src/main.ts" },
  { name: "correlator", cwd: "services/incident-correlator", entry: "src/main.ts" },
] as const;

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WIDTH = Math.max(...TARGETS.map((t) => t.name.length));

function pipe(name: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const prefix = `${name.padEnd(WIDTH)} | `;
  return (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) console.log(prefix + line);
    }
    if (buffer) console.log(prefix + buffer);
  })();
}

const children = TARGETS.map((target) => {
  const child = Bun.spawn(["bun", "--hot", target.entry], {
    cwd: `${ROOT}/${target.cwd}`,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  void pipe(target.name, child.stdout);
  void pipe(target.name, child.stderr);
  return child;
});

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(children.map((child) => child.exited));
