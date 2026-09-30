/**
 * agent-factory dashboard server — zero runtime dependencies (node:http + node:fs).
 *
 * Manages one or more WORKSPACES (a directory holding factory.yaml, backlog/ and
 * runs/). Per workspace it: reads the dispatcher's append-only events.jsonl and
 * streams it over SSE; writes operator commands to control.jsonl (the dispatcher
 * polls it) — one writer per file, in each direction; and launches `factory plan`
 * / `factory run` as child processes so the whole workflow runs from the browser.
 *
 * The workspace registry lives in workspaces.json next to the server's initial
 * --workdir. Cross-platform by construction: file growth is detected by polling
 * size+offset (fs.watch is unreliable for appends on Windows network/temp paths).
 *
 * The server itself is built by createDashboardServer (server-app.ts: gates,
 * static routes, route groups in server-routes-*.ts). This file is the CLI:
 * parseArgs, listen, and the process-level wiring — crash handlers and a clean
 * shutdown that takes every spawned child process down with the server.
 */

import { parseArgs } from "./server-core.js";
import { createDashboardServer } from "./server-app.js";

/** How long shutdown waits after issuing the kills (taskkill is itself a child
 *  process on Windows) before the process exits. */
const SHUTDOWN_GRACE_MS = 500;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const app = createDashboardServer(opts);

  // A stray rejection or throw in a background callback (a child's exit handler,
  // a timer) must not kill the dashboard and orphan the runs it supervises: log
  // it and keep serving.
  process.on("unhandledRejection", (reason) => {
    console.error("dashboard: unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("dashboard: uncaught exception:", err);
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`dashboard: ${signal} — stopping child processes and exiting`);
    app.shutdown();
    app.server.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A listen failure (port taken, bad --host) is fatal — and must stay so even
  // with the uncaughtException logger above, or the process would idle unbound.
  app.server.on("error", (err) => {
    console.error(`dashboard: cannot serve on ${opts.host}:${opts.port}:`, err);
    app.shutdown();
    process.exit(1);
  });

  app.server.listen(opts.port, opts.host, () => {
    console.log(
      `dashboard: http://${opts.host}:${opts.port}  ` +
        `(${app.registry.workspaces.size} workspace(s), registry: ${app.registry.file})`,
    );
    console.log(`open:      http://localhost:${opts.port}/?token=${app.token}`);
  });
}

main();
