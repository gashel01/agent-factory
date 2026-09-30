/* Per-workspace routes for the shared picture of the codebase: the living
 * architecture (agent-maintained world-model + a real import graph + the
 * operator's notes), the freehand sketch board, and the live coordination view.
 * Split out of server-routes-run.ts — no behaviour change. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { json, latestRun, readBody, readJSON, workspaceRepo, writeFileAtomic } from "./server-core.js";
import type { WsRouteCtx } from "./server-routes.js";

/** Fold coordination events (across every run) into the persistent world-model the
 *  Architecture tab shows: which symbol lives where, the decisions taken, and which
 *  ticket last landed each file. Latest wins for symbols/decisions. */
function foldWorldModel(events: Array<Record<string, unknown>>): {
  symbols: Array<{ name: string; file: string }>;
  decisions: Array<{ key: string; value: string; ticket: string }>;
  files: Array<{ file: string; ticket: string }>;
} {
  const symbols = new Map<string, string>();
  const decisions = new Map<string, { value: string; ticket: string }>();
  const files = new Map<string, string>();
  for (const e of events) {
    const tk = String(e.ticket ?? "");
    if (e.kind === "landed") {
      for (const f of (e.files as string[] ?? [])) files.set(String(f), tk);
      for (const [name, file] of Object.entries((e.symbols as Record<string, string>) ?? {})) {
        symbols.set(String(name), String(file));
      }
    } else if (e.kind === "decision") {
      decisions.set(String(e.key ?? ""), { value: String(e.value ?? ""), ticket: tk });
    }
  }
  return {
    symbols: [...symbols].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name)),
    decisions: [...decisions].filter(([k]) => k).map(([key, v]) => ({ key, value: v.value, ticket: v.ticket }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    files: [...files].map(([file, ticket]) => ({ file, ticket })).sort((a, b) => a.file.localeCompare(b.file)),
  };
}

// --- architecture diagram: a real import graph derived from the repo -----------
// The world-model lists tell you WHAT exists; this shows how it fits together —
// which modules depend on which, classified by role (ui / server / data / core),
// so the Architecture tab can draw the services-and-flow picture, not just lists.

interface ArchNode { id: string; label: string; kind: string; }
interface ArchGraph {
  nodes: ArchNode[]; edges: Array<{ from: string; to: string }>;
  truncated: boolean; total: number;
}

const ARCH_SRC_EXT = /\.(tsx?|jsx?|py)$/;
const ARCH_SKIP_DIR = new Set([
  "node_modules", "dist", "build", "out", ".next", "coverage", "__pycache__",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".factory", ".git",
  // "runs" holds per-run agent worktrees (whole stale copies of the repo) and
  // "wt"/"worktrees" their checkouts — scanning them duplicates every file.
  "runs", "wt", "worktrees", ".worktrees",
]);
const ARCH_MAX_NODES = 44;

/** The sketch board is stored whole; 2 MB is far past any hand-drawn board. */
const BOARD_MAX_BYTES = 2_000_000;

/** Repo-relative, forward-slash path join+normalise (no fs access). */
function archJoin(dir: string, spec: string): string {
  const parts = (dir ? dir.split("/") : []);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function archClassify(id: string): string {
  const p = id.toLowerCase();
  if (/(^|\/)(tests?|spec|conftest)|\.(test|spec)\.|_test\./.test(p)) return "test";
  if (/(db|store|memor|persist|sql|cache|coordination|events|journal|backlog|model\.)/.test(p)) return "data";
  if (/(server|route|api|handler|dispatch|merge|worktree|sandbox|webhook|supervise)/.test(p)) return "server";
  if (/(__main__|(^|\/)main\.|(^|\/)cli\.|(^|\/)index\.|(^|\/)app\.)/.test(p)) return "entry";
  if (/\.(tsx|jsx)$|(view|modal|screen|widget|component|board|panel|dock)/.test(p)) return "ui";
  return "core";
}

function archWalk(root: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < 900) {
    const rel = stack.pop()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ARCH_SKIP_DIR.has(e.name) && !e.name.startsWith(".")) stack.push(childRel);
      } else if (ARCH_SRC_EXT.test(e.name)) {
        out.push(childRel);
      }
    }
  }
  return out;
}

function archResolveTs(spec: string, from: string, files: Set<string>): string | null {
  const base = archJoin(from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "", spec.replace(/\.jsx?$/, ""));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(c)) return c;
  }
  return null;
}

function archResolvePy(dots: number, tail: string, from: string, files: Set<string>): string | null {
  const parts = tail ? tail.split(".").filter(Boolean) : [];
  if (dots > 0) {                                   // relative: from .x / from ..a.b
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
    for (let i = 1; i < dots; i++) dir.pop();
    const target = [...dir, ...parts].join("/");
    for (const c of [`${target}.py`, `${target}/__init__.py`]) if (files.has(c)) return c;
    return null;
  }
  if (parts.length === 0) return null;              // absolute: import a.b.c — match a tail
  const tailPath = parts.join("/");
  for (const c of files) {
    if (c === `${tailPath}.py` || c.endsWith(`/${tailPath}.py`)
      || c === `${tailPath}/__init__.py` || c.endsWith(`/${tailPath}/__init__.py`)) return c;
  }
  return null;
}

const ARCH_TS_IMPORT = /(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const ARCH_PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import/gm;
const ARCH_PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+)/gm;

function archEdges(root: string, id: string, files: Set<string>): string[] {
  let src: string;
  try { src = readFileSync(join(root, id), "utf-8"); } catch { return []; }
  if (src.length > 400_000) src = src.slice(0, 400_000);
  const hits = new Set<string>();
  if (id.endsWith(".py")) {
    for (const m of src.matchAll(ARCH_PY_FROM)) {
      const t = archResolvePy((m[1] ?? "").length, m[2] ?? "", id, files);
      if (t && t !== id) hits.add(t);
    }
    for (const m of src.matchAll(ARCH_PY_IMPORT)) {
      const t = archResolvePy(0, m[1] ?? "", id, files);
      if (t && t !== id) hits.add(t);
    }
  } else {
    for (const m of src.matchAll(ARCH_TS_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith(".")) continue;   // local imports only
      const t = archResolveTs(spec, id, files);
      if (t && t !== id) hits.add(t);
    }
  }
  return [...hits];
}

function buildArchGraph(root: string): ArchGraph {
  const all = archWalk(root).filter((f) => archClassify(f) !== "test");
  const fileSet = new Set(all);
  const rawEdges: Array<{ from: string; to: string }> = [];
  for (const id of all) for (const to of archEdges(root, id, fileSet)) rawEdges.push({ from: id, to });

  // Rank by connectivity so a big repo still yields a legible diagram: keep the
  // most-connected files (the hubs that define the shape), drop the long tail.
  const degree = new Map<string, number>();
  for (const id of all) degree.set(id, 0);
  for (const e of rawEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...all].sort((a, b) => (degree.get(b)! - degree.get(a)!) || a.localeCompare(b));
  const keep = new Set(ranked.slice(0, ARCH_MAX_NODES));
  const nodes: ArchNode[] = ranked.filter((id) => keep.has(id) && degree.get(id)! > 0)
    .map((id) => ({ id, label: id.slice(id.lastIndexOf("/") + 1), kind: archClassify(id) }));
  const kept = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges = rawEdges.filter((e) => {
    if (!kept.has(e.from) || !kept.has(e.to)) return false;
    const k = `${e.from}\u0000${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { nodes, edges, truncated: nodes.length < all.filter((id) => degree.get(id)! > 0).length, total: all.length };
}

export async function handleArchitectureRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws } = ctx;

  if (url.pathname === "/api/architecture") {
    // The living architecture: the agent-maintained world-model (folded from every
    // run's coordination log, so it survives runs) plus the operator's own notes.
    const notesFile = join(ws.workdir, "architecture.md");
    if (req.method === "PUT") {
      const { notes } = await readJSON(req) as { notes?: string };
      writeFileAtomic(notesFile, String(notes ?? ""));
      json(res, 200, { ok: true });
      return true;
    }
    const runsDir = ws.tailer.runsDir;
    const events: Array<Record<string, unknown>> = [];
    if (existsSync(runsDir)) {
      for (const run of readdirSync(runsDir)) {
        const f = join(runsDir, run, "coordination.jsonl");
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, "utf-8").split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try { events.push(JSON.parse(t)); } catch { /* skip a torn line */ }
        }
      }
    }
    json(res, 200, {
      map: foldWorldModel(events),
      notes: existsSync(notesFile) ? readFileSync(notesFile, "utf-8") : "",
      // The diagram is derived from the actual source, which lives in the repo the
      // workspace targets — not the workspace dir (that holds runs/backlog/config).
      graph: buildArchGraph(workspaceRepo(ws) ?? ws.workdir),
    });
    return true;
  }

  if (url.pathname === "/api/board") {
    // The shared sketch board: the operator's freehand shapes (and system nodes
    // they dropped from the world-model) — a spatial layer next to the kanban.
    // Persisted whole as one JSON doc, same as the architecture notes.
    const boardFile = join(ws.workdir, "board.json");
    if (req.method === "PUT") {
      // Store verbatim but bounded — a runaway client must not write an
      // unbounded file (readBody answers 413 past the cap).
      const body = await readBody(req, BOARD_MAX_BYTES);
      try { JSON.parse(body); } catch { json(res, 400, { error: "invalid JSON" }); return true; }
      writeFileAtomic(boardFile, body);
      json(res, 200, { ok: true });
      return true;
    }
    let shapes: unknown = [];
    if (existsSync(boardFile)) {
      try { shapes = (JSON.parse(readFileSync(boardFile, "utf-8")) as { shapes?: unknown }).shapes ?? []; }
      catch { shapes = []; }
    }
    json(res, 200, { shapes });
    return true;
  }

  if (url.pathname === "/api/coordination") {
    // The shared workspace agents see: who claims/lands which files, the symbols
    // now defined, and the decisions/notes they've posted. Folded from the run's
    // append-only coordination.jsonl (mirrors factory.coordination.world_index).
    const runsDir = ws.tailer.runsDir;
    const run = latestRun(runsDir);
    const file = run ? join(runsDir, run, "coordination.jsonl") : "";
    const events: Array<Record<string, unknown>> = [];
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* skip a half-written line */ }
      }
    }
    const claimFiles = new Map<string, string[]>();
    const landedFiles = new Map<string, string[]>();
    const ended = new Set<string>();
    const symbols: Array<{ name: string; file: string; ticket: string }> = [];
    const symSeen = new Set<string>();
    const decisions = new Map<string, { value: string; ticket: string }>();
    const discoveries: Array<{ ticket: string; note: string }> = [];
    for (const e of events) {
      const tk = String(e.ticket ?? "");
      const kind = e.kind;
      if (kind === "claim") {
        claimFiles.set(tk, (e.writes as string[] ?? []).map(String));
      } else if (kind === "landed") {
        ended.add(tk);
        landedFiles.set(tk, (e.files as string[] ?? []).map(String));
        for (const [name, f] of Object.entries((e.symbols as Record<string, string>) ?? {})) {
          const key = `${name}@${f}`;
          if (!symSeen.has(key)) { symSeen.add(key); symbols.push({ name: String(name), file: String(f), ticket: tk }); }
        }
      } else if (kind === "released") {
        ended.add(tk);
      } else if (kind === "decision") {
        decisions.set(String(e.key ?? ""), { value: String(e.value ?? ""), ticket: tk });
      } else if (kind === "discovery") {
        discoveries.push({ ticket: tk, note: String(e.note ?? "") });
      }
    }
    const agents: Array<{ ticket: string; files: string[]; state: string; symbols: string[] }> = [];
    for (const tk of new Set([...claimFiles.keys(), ...landedFiles.keys()])) {
      const landed = landedFiles.has(tk);
      agents.push({
        ticket: tk,
        files: landed ? landedFiles.get(tk)! : (claimFiles.get(tk) ?? []),
        state: landed ? "landed" : (ended.has(tk) ? "released" : "live"),
        symbols: symbols.filter((s) => s.ticket === tk).map((s) => s.name),
      });
    }
    agents.sort((a, b) => a.ticket.localeCompare(b.ticket));
    json(res, 200, {
      run,
      agents,
      symbols: symbols.sort((a, b) => a.name.localeCompare(b.name)),
      decisions: [...decisions.entries()]
        .filter(([k]) => k)
        .map(([key, v]) => ({ key, value: v.value, ticket: v.ticket }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      discoveries: discoveries.slice(-20),
    });
    return true;
  }

  return false;
}
