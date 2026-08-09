/* Extracted from server.ts — mechanical split. Per-workspace routes for the live
 * preview of the built product and the generic capsule cockpit (actions, panels,
 * services, chat edits, provisioning, consents, artifacts, the agent judge). */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { json, readBody, workspaceRepo } from "./server-core.js";
import { capsuleDiff } from "./capsule-core.js";
import {
  capsuleEnv, capsuleFile, capsuleView, captureShell, chromeBin, detectPreview,
  generateCapsule, generateCapsuleChat, generateFix, generateProvision, judgeAction,
  loadCapsule, runCapsuleAction, runCapsuleConsent, screenshotUrl, startPreview,
  startService, stopPreview, stopService,
} from "./server-preview.js";
import type { WsRouteCtx } from "./server-routes.js";

export async function handlePreviewRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws } = ctx;

  /* ---------------- live preview of the built product ---------------- */

  if (url.pathname === "/api/preview/detect" && req.method === "GET") {
    const repo = resolve(url.searchParams.get("repo") ?? "");
    if (!repo || !existsSync(repo)) {
      json(res, 400, { ok: false, error: "repo path does not exist" });
      return true;
    }
    json(res, 200, detectPreview(repo));
    return true;
  }
  if (url.pathname === "/api/preview" && req.method === "GET") {
    json(res, 200, {
      kind: ws.preview.kind,
      state: ws.preview.state,
      url: ws.preview.url,
      output: ws.preview.output.slice(-2000),
    });
    return true;
  }
  if (url.pathname === "/api/preview" && req.method === "POST") {
    try {
      const { repo } = JSON.parse(await readBody(req)) as { repo?: string };
      const dir = resolve(repo ?? "");
      if (!dir || !existsSync(dir)) throw new Error("repo path does not exist");
      const kind = startPreview(ws, dir);
      json(res, 200, { ok: true, kind });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname === "/api/preview/stop" && req.method === "POST") {
    stopPreview(ws);
    json(res, 200, { ok: true });
    return true;
  }
  // Freeze-frame of the running app — headless screenshot of the live preview
  // URL, streamed as PNG. Visual evidence you can hand to the supervisor or keep
  // as proof the build renders (the same infra the capsule judge uses).
  if (url.pathname === "/api/preview/shot" && req.method === "GET") {
    const target = ws.preview.url;
    if (!target) { json(res, 400, { ok: false, error: "no live preview to capture" }); return true; }
    const bin = chromeBin();
    if (!bin) { json(res, 400, { ok: false, error: "no Chrome or Edge found to render the screenshot" }); return true; }
    const out = join(ws.workdir, ".preview-shot.png");
    if (!(await screenshotUrl(bin, target, out))) {
      json(res, 500, { ok: false, error: "the screenshot could not be captured" });
      return true;
    }
    const buf = readFileSync(out);
    res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
    res.end(buf);
    return true;
  }

  /* -------- capsule: the generic, app-agnostic project cockpit -------- */
  if (url.pathname === "/api/capsule" && req.method === "GET") {
    json(res, 200, await capsuleView(ws));
    return true;
  }
  if (url.pathname === "/api/capsule/panel" && req.method === "GET") {
    const capsule = loadCapsule(ws);
    const panel = (capsule?.panels ?? []).find((p) => p.id === url.searchParams.get("id"));
    if (!capsule || !panel) { json(res, 404, { ok: false, error: "unknown panel" }); return true; }
    if (!panel.source) { json(res, 200, { output: "" }); return true; } // html panel: nothing to run
    const { out } = await captureShell(panel.source, workspaceRepo(ws) ?? ws.workdir, capsuleEnv(ws, capsule));
    json(res, 200, { output: out.slice(-4000) });
    return true;
  }
  if (url.pathname === "/api/capsule/action" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === id);
      if (!capsule || !action) throw new Error("unknown action");
      if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
      void runCapsuleAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname === "/api/capsule/status" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const r = ws.capsule.runs.get(id);
    json(res, 200, { state: r?.state ?? "idle", output: (r?.output ?? "").slice(-8000) });
    return true;
  }
  if (url.pathname === "/api/capsule/generate" && req.method === "POST") {
    if (!workspaceRepo(ws)) { json(res, 400, { ok: false, error: "no repository for this project" }); return true; }
    if (ws.capsule.runs.get("__generate__")?.state === "running") { json(res, 409, { ok: false, error: "already generating" }); return true; }
    generateCapsule(ws);
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/capsule/provision" && req.method === "POST") {
    if (!loadCapsule(ws)) { json(res, 400, { ok: false, error: "no capsule for this project" }); return true; }
    if (ws.capsule.runs.get("__provision__")?.state === "running") { json(res, 409, { ok: false, error: "already provisioning" }); return true; }
    void generateProvision(ws);
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/capsule/fix" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === id);
      if (!capsule || !action) throw new Error("unknown action");
      if (ws.capsule.runs.get(action.id)?.state === "running") throw new Error("already running");
      void generateFix(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/chat" && req.method === "POST") {
    try {
      const { message } = JSON.parse(await readBody(req)) as { message?: string };
      if (!message?.trim()) throw new Error("message is required");
      if (!loadCapsule(ws)) throw new Error("no capsule for this project");
      if (ws.capsule.runs.get("__chat__")?.state === "running") throw new Error("already editing");
      generateCapsuleChat(ws, message.trim());
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/chat/draft" && req.method === "GET") {
    const draft = ws.capsule.chatDraft;
    json(res, 200, { has: !!draft, diff: draft ? capsuleDiff(loadCapsule(ws), draft) : [] });
    return true;
  }
  if (url.pathname === "/api/capsule/chat/apply" && req.method === "POST") {
    try {
      if (!ws.capsule.chatDraft) throw new Error("nothing to apply");
      writeFileSync(capsuleFile(ws), JSON.stringify(ws.capsule.chatDraft, null, 2), "utf-8");
      ws.capsule.chatDraft = null;
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/chat/discard" && req.method === "POST") {
    ws.capsule.chatDraft = null;
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/capsule/judge" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === id);
      if (!capsule || !action) throw new Error("unknown action");
      if (ws.capsule.judgments.get(action.id)?.state === "running") throw new Error("already judging");
      void judgeAction(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/judge" && req.method === "GET") {
    const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
    json(res, 200, {
      state: jr?.state ?? "idle", output: (jr?.output ?? "").slice(-6000),
      verdict: jr?.verdict ?? null, confidence: jr?.confidence ?? null,
      reasons: jr?.reasons ?? [], hasShot: !!(jr?.shot && existsSync(jr.shot)),
    });
    return true;
  }
  if (url.pathname === "/api/capsule/judge/shot" && req.method === "GET") {
    const jr = ws.capsule.judgments.get(url.searchParams.get("id") ?? "");
    if (!jr?.shot || !existsSync(jr.shot)) { json(res, 404, { ok: false, error: "no screenshot" }); return true; }
    const buf = readFileSync(jr.shot);
    res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "no-store" });
    res.end(buf);
    return true;
  }
  if (url.pathname === "/api/capsule/service" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      const capsule = loadCapsule(ws);
      const action = capsule?.actions.find((a) => a.id === id);
      if (!capsule || !action || !action.service) throw new Error("not a service action");
      void startService(ws, capsule, action, workspaceRepo(ws) ?? ws.workdir);
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/service/stop" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      stopService(ws, id ?? "");
      json(res, 200, { ok: true });
    } catch (err) { json(res, 400, { ok: false, error: String(err) }); }
    return true;
  }
  if (url.pathname === "/api/capsule/service" && req.method === "GET") {
    const s = ws.capsule.services.get(url.searchParams.get("id") ?? "");
    json(res, 200, { state: s?.state ?? "stopped", url: s?.url ?? null, output: (s?.output ?? "").slice(-8000) });
    return true;
  }
  if (url.pathname === "/api/capsule/consent" && req.method === "POST") {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      const capsule = loadCapsule(ws);
      const consent = (capsule?.consents ?? []).find((c) => c.id === id);
      if (!capsule || !consent) throw new Error("unknown consent");
      const r = await runCapsuleConsent(ws, capsule, consent, workspaceRepo(ws) ?? ws.workdir);
      if (r.state !== "ok") throw new Error(r.output.trim().slice(-400) || "provisioning failed");
      json(res, 200, { ok: true, output: r.output.trim() });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname === "/api/capsule/artifact" && req.method === "GET") {
    const capsule = loadCapsule(ws);
    const action = capsule?.actions.find((a) => a.id === url.searchParams.get("id"));
    const repo = workspaceRepo(ws) ?? ws.workdir;
    const file = action?.artifact ? join(repo, action.artifact) : null;
    if (!file || !existsSync(file)) { json(res, 404, { ok: false, error: "no artifact built yet" }); return true; }
    const buf = readFileSync(file);
    const type = extname(file).toLowerCase() === ".apk"
      ? "application/vnd.android.package-archive" : "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-disposition": `attachment; filename="${basename(file)}"`,
      "content-length": buf.length,
      "cache-control": "no-store",
    });
    res.end(buf);
    return true;
  }

  return false;
}
