/* Extracted from server.ts — mechanical split. Per-workspace routes: the
 * project's repo path, the companion timeline, learned facts (memory), and the
 * knowledge base (ragmcp docs). */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { json, readBody, toPosix, workspaceRepo } from "./server-core.js";
import {
  knowledgePaths, readApplied, readDocs, readFacts, runRagmcp, scaffoldKnowledge,
  setKnowledgeEnabled, writeDocs, writeFacts,
} from "./server-knowledge.js";
import type { Fact, KnowledgeDoc } from "./server-knowledge.js";
import {
  chatObservations, companionTimeline, readBriefings,
} from "./server-companion.js";
import type { WsRouteCtx } from "./server-routes.js";

export async function handleMemoryRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, registry, opts, ws, globalMemFile } = ctx;

  // The repo belongs to the PROJECT (like /api/plan does as a side-effect):
  // persist it so it survives reloads, browser switches and the phone. Settings
  // is the one place a project's repo path is set without drafting work.
  if (url.pathname === "/api/repo/path" && req.method === "POST") {
    try {
      const { path } = JSON.parse(await readBody(req)) as { path?: string };
      ws.repo = path?.trim() ? resolve(path.trim()) : null;
      registry.save();
      json(res, 200, { ok: true, repo: ws.repo });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname === "/api/companion" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 400, 1000);
    // Event-derived observations + persisted LLM briefings, merged by time.
    // The sort is stable, so a briefing settles right after the same-ts events.
    // Events + LLM briefings + the operator's conversation: one merged thread.
    const merged = [...companionTimeline(ws.tailer.runsDir, limit), ...readBriefings(ws), ...chatObservations(ws)]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .slice(-limit);
    json(res, 200, { observations: merged });
    return true;
  }

  const projectMemFile = join(ws.workdir, "memory.json");

  /* ---------------- learned facts (memory) ---------------- */

  if (url.pathname === "/api/memory" && req.method === "GET") {
    const applied = readApplied(join(ws.workdir, "memory.applied.json"));
    const withCount = (f: Fact): Fact => ({ ...f, applied: applied[f.id] ?? 0 });
    const project = readFacts(projectMemFile).map((f) => withCount({ ...f, scope: "project" as const }));
    const global = readFacts(globalMemFile).map((f) => withCount({ ...f, scope: "global" as const }));
    json(res, 200, { facts: [...global, ...project] });
    return true;
  }
  if (url.pathname === "/api/memory" && req.method === "POST") {
    try {
      const { text, scope, ticketId } = JSON.parse(await readBody(req)) as {
        text?: string; scope?: string; ticketId?: string | null;
      };
      if (!text?.trim()) throw new Error("text is required");
      const isGlobal = scope === "global";
      const file = isGlobal ? globalMemFile : projectMemFile;
      const facts = readFacts(file);
      facts.unshift({
        id: "F-" + Date.now().toString(36),
        text: text.trim(),
        scope: isGlobal ? "global" : "project",
        ticketId: ticketId || null,
        createdTs: new Date().toISOString(),
      });
      writeFacts(file, facts);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname.startsWith("/api/memory/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/memory/".length));
    const files = [globalMemFile, projectMemFile];
    if (req.method === "DELETE") {
      for (const file of files) {
        const facts = readFacts(file);
        const next = facts.filter((f) => f.id !== id);
        if (next.length !== facts.length) writeFacts(file, next);
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "PUT") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          text?: string; scope?: string; ticketId?: string | null;
        };
        // Pull the fact out of whichever file holds it (a scope change moves it).
        let existing: Fact | undefined;
        for (const file of files) {
          const facts = readFacts(file);
          const found = facts.find((f) => f.id === id);
          if (found) { existing = found; writeFacts(file, facts.filter((f) => f.id !== id)); }
        }
        if (!existing) throw new Error("fact not found");
        const isGlobal = (body.scope ?? existing.scope) === "global";
        const target = isGlobal ? globalMemFile : projectMemFile;
        const facts = readFacts(target);
        facts.unshift({
          ...existing,
          text: body.text ?? existing.text,
          ticketId: body.ticketId !== undefined ? body.ticketId : existing.ticketId,
          scope: isGlobal ? "global" : "project",
        });
        writeFacts(target, facts);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err) });
      }
      return true;
    }
  }

  /* ---------------- knowledge base (ragmcp docs) ---------------- */

  const kp = knowledgePaths(ws.workdir);
  const configFile = join(ws.workdir, "factory.yaml");

  if (url.pathname === "/api/knowledge" && req.method === "GET") {
    const enabled = existsSync(configFile) && /^\s*mcp_config:/m.test(readFileSync(configFile, "utf-8"));
    json(res, 200, { enabled, ready: existsSync(kp.mcp), docs: readDocs(kp.index) });
    return true;
  }
  if (url.pathname === "/api/knowledge" && req.method === "POST") {
    try {
      const { name, content } = JSON.parse(await readBody(req)) as { name?: string; content?: string };
      if (!name?.trim() || !content) throw new Error("name and content are required");
      // Keep only a safe basename; default a .md extension for pasted notes.
      let safe = basename(name.trim()).replace(/[^\w.\- ]+/g, "_");
      if (!extname(safe)) safe += ".md";
      scaffoldKnowledge(ws.workdir, opts.ragmcp); // idempotent; ensures store + config exist
      const file = join(kp.docsDir, safe);
      writeFileSync(file, content, "utf-8");
      const ingest = await runRagmcp(opts.ragmcp, ["ingest", toPosix(file), "--config", toPosix(kp.yaml)], ws.workdir);
      const doc: KnowledgeDoc = {
        id: "K-" + Date.now().toString(36),
        name: safe,
        size: Buffer.byteLength(content, "utf-8"),
        addedTs: new Date().toISOString(),
        chunks: ingest.ok ? Number(ingest.out.match(/chunks_new=(\d+)/)?.[1] ?? 0) : null,
        ...(ingest.ok ? {} : { error: ingest.out.slice(-300) }),
      };
      const docs = readDocs(kp.index).filter((d) => d.name !== safe);
      docs.unshift(doc);
      writeDocs(kp.index, docs);
      // 200 even on ingest failure: the HTTP call succeeded; the failure is a
      // domain result the client reads from doc.error (fetchJSON throws on !2xx).
      json(res, 200, { ok: ingest.ok, doc });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname === "/api/knowledge/enable" && req.method === "POST") {
    try {
      const { enabled } = JSON.parse(await readBody(req)) as { enabled?: boolean };
      if (enabled) scaffoldKnowledge(ws.workdir, opts.ragmcp);
      setKnowledgeEnabled(configFile, !!enabled);
      json(res, 200, { ok: true, enabled: !!enabled });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }
  if (url.pathname.startsWith("/api/knowledge/") && req.method === "DELETE") {
    const id = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
    const docs = readDocs(kp.index);
    const doc = docs.find((d) => d.id === id);
    if (doc) {
      const file = join(kp.docsDir, doc.name);
      if (existsSync(file)) unlinkSync(file);
      // --sync drops from the store any source no longer on disk.
      await runRagmcp(opts.ragmcp, ["ingest", toPosix(kp.docsDir), "--config", toPosix(kp.yaml), "--sync"], ws.workdir);
      writeDocs(kp.index, docs.filter((d) => d.id !== id));
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
