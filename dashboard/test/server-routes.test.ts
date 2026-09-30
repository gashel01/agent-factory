// Route tests: boot the real dashboard server (createDashboardServer) on an
// ephemeral port with a throwaway workdir, and drive it over HTTP. These pin the
// request gates — auth per method, Host check, body limits, JSON errors, the repo
// allowlist and the run lock — which unit tests of the handlers would bypass.
//
// node:http rather than fetch: the Host header must be settable (fetch forbids it).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDashboardServer, type DashboardServer } from "../src/server-app.js";
import { MAX_BODY_BYTES, parseArgs } from "../src/server-core.js";

interface Reply { status: number; body: string; json: Record<string, unknown> }

interface Server { app: DashboardServer; port: number; workdir: string }

/** A server whose child-process command can never do real work. */
async function boot(host: string): Promise<Server> {
  const workdir = mkdtempSync(join(tmpdir(), "dash-routes-"));
  const opts = parseArgs(["--workdir", workdir, "--host", host]);
  opts.factory = [process.execPath, "-e", "0"]; // set directly: execPath may contain spaces
  const app = createDashboardServer(opts, { here: workdir, publicDir: workdir });
  // Always listen on loopback: `host` only decides the gates (LAN vs local).
  await new Promise<void>((ok) => app.server.listen(0, "127.0.0.1", ok));
  return { app, port: (app.server.address() as AddressInfo).port, workdir };
}

async function stop(s: Server): Promise<void> {
  s.app.shutdown();
  s.app.server.closeAllConnections();
  await new Promise<void>((ok) => s.app.server.close(() => ok()));
  // Retries: a killed child may release its cwd a beat after the kill (Windows).
  rmSync(s.workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function call(
  s: Server, method: string, path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string | number>; chunked?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { host: `127.0.0.1:${s.port}`, ...opts.headers };
    if (opts.body !== undefined && !opts.chunked && headers["content-length"] === undefined) {
      headers["content-length"] = Buffer.byteLength(opts.body);
    }
    const req = request({ host: "127.0.0.1", port: s.port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body, json: parsed });
        req.destroy(); // an oversized upload may still be streaming — drop it
      });
    });
    // The server may answer (413) and close before the upload finishes.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ECONNRESET" && err.code !== "EPIPE") reject(err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const authed = (s: Server): Record<string, string> => ({ "x-factory-token": s.app.token });

let local: Server;
let lan: Server;
before(async () => {
  local = await boot("127.0.0.1");
  lan = await boot("0.0.0.0");
});
after(async () => {
  await stop(local);
  await stop(lan);
});

test("a PUT without the token is refused; with it, it is applied", async () => {
  const body = JSON.stringify({ content: "agent:\n  model: haiku\n" });
  const denied = await call(local, "PUT", "/api/config", { body });
  assert.equal(denied.status, 401);

  const wrong = await call(local, "PUT", "/api/config", { body, headers: { "x-factory-token": "nope" } });
  assert.equal(wrong.status, 401);

  const ok = await call(local, "PUT", "/api/config", { body, headers: authed(local) });
  assert.equal(ok.status, 200);
  assert.equal(readFileSync(join(local.workdir, "factory.yaml"), "utf-8"), "agent:\n  model: haiku\n");

  // ?token= stays accepted (EventSource can't send headers).
  const viaQuery = await call(local, "PUT", `/api/config?token=${local.app.token}`, { body });
  assert.equal(viaQuery.status, 200);
});

test("DELETE is gated like any mutation", async () => {
  assert.equal((await call(local, "DELETE", "/api/backlog/T-1.md")).status, 401);
  assert.equal((await call(local, "DELETE", "/api/backlog/T-1.md", { headers: authed(local) })).status, 200);
});

test("on loopback, GETs stay open", async () => {
  assert.equal((await call(local, "GET", "/api/config")).status, 200);
});

test("bound to the LAN, GETs need the token — except the APK download", async () => {
  assert.equal((await call(lan, "GET", "/api/config")).status, 401);
  assert.equal((await call(lan, "GET", "/api/config", { headers: authed(lan) })).status, 200);
  assert.equal((await call(lan, "GET", `/api/config?token=${lan.app.token}`)).status, 200);
  // No capsule here, so 404 — the point is it is not 401.
  assert.equal((await call(lan, "GET", "/api/capsule/artifact?id=app")).status, 404);
});

test("invalid JSON is a 400, and the server keeps serving", async () => {
  const bad = await call(local, "POST", "/api/control", { body: "{not json", headers: authed(local) });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /invalid JSON/);

  // A route that used to parse outside any try/catch (it would crash the process).
  const ticket = await call(local, "PUT", "/api/backlog/T-2.md", { body: "{", headers: authed(local) });
  assert.equal(ticket.status, 400);

  assert.equal((await call(local, "GET", "/api/config")).status, 200);
});

test("an oversized body is a 413 — announced or streamed", async () => {
  const announced = await call(local, "POST", "/api/control", {
    headers: { ...authed(local), "content-length": MAX_BODY_BYTES + 1 },
  });
  assert.equal(announced.status, 413);

  // Chunked (no content-length) past the sketch board's own 2 MB cap.
  const streamed = await call(local, "PUT", "/api/board", {
    body: "x".repeat(2_100_000), chunked: true, headers: authed(local),
  });
  assert.equal(streamed.status, 413);

  assert.equal((await call(local, "GET", "/api/config")).status, 200);
});

test("a foreign Host header is rejected (DNS rebinding)", async () => {
  const r = await call(local, "GET", "/api/config", { headers: { host: "evil.example.com" } });
  assert.equal(r.status, 403);
  const page = await call(local, "GET", "/", { headers: { host: `evil.example.com:${local.port}` } });
  assert.equal(page.status, 403);
  assert.equal((await call(local, "GET", "/api/config", { headers: { host: `localhost:${local.port}` } })).status, 200);
});

test("the git explorer only serves repositories of registered projects", async () => {
  const outside = mkdtempSync(join(tmpdir(), "dash-outside-"));
  try {
    mkdirSync(join(outside, ".git"));
    const q = `/api/repo/tree?repo=${encodeURIComponent(outside)}`;
    assert.equal((await call(local, "GET", q)).status, 403);
    assert.equal((await call(local, "GET", `/api/prs?repo=${encodeURIComponent(outside)}`)).status, 403);

    // Once it is the project's repo, it is served (and refs are still validated).
    const set = await call(local, "POST", "/api/repo/path", {
      body: JSON.stringify({ path: outside }), headers: authed(local),
    });
    assert.equal(set.status, 200);
    const flag = await call(local, "GET", `/api/repo/tree?repo=${encodeURIComponent(outside)}&ref=--output=x`);
    assert.equal(flag.status, 400);
    assert.match(String(flag.json.error), /bad ref/);
  } finally {
    await call(local, "POST", "/api/repo/path", { body: JSON.stringify({ path: "" }), headers: authed(local) });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a live CLI run lock blocks a dashboard run or loop (409)", async () => {
  const runs = join(local.workdir, "runs");
  mkdirSync(runs, { recursive: true });
  const lock = join(runs, ".factory.lock");
  // Our own pid: guaranteed alive for the duration of the test.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cmd: "factory run" }));
  try {
    const run = await call(local, "POST", "/api/run", { body: "{}", headers: authed(local) });
    assert.equal(run.status, 409);
    assert.match(String(run.json.error), new RegExp(`pid ${process.pid}`));

    const loop = await call(local, "POST", "/api/loop/start", {
      body: JSON.stringify({ repo: local.workdir, budget: 1, objective: "x" }), headers: authed(local),
    });
    assert.equal(loop.status, 409);
  } finally {
    rmSync(lock, { force: true });
  }
});

test("a stale lock (dead pid) does not block", async () => {
  const runs = join(local.workdir, "runs");
  mkdirSync(runs, { recursive: true });
  const lock = join(runs, ".factory.lock");
  // Far above any real pid range: never alive.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, started: "", cmd: "factory run" }));
  try {
    // Spawns `node -e 0` as the "factory" — returns at once, does nothing.
    const run = await call(local, "POST", "/api/run", { body: "{}", headers: authed(local) });
    assert.equal(run.status, 200);
    // Let it exit: Windows can't remove a directory that is a live process's cwd.
    const child = [...local.app.registry.workspaces.values()][0]?.jobProcs.run;
    if (child && child.exitCode === null) await once(child, "exit");
  } finally {
    rmSync(lock, { force: true });
  }
});
