/* Per-workspace routes for tickets and their inputs: the backlog files, the
 * board's hide/unhide list, AI ticket drafting and hand-work review, and file /
 * image attachments. Split out of server-routes-run.ts — no behaviour change. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  askOneShot, json, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, readJSON, runCmd, SAFE_NAME, saveHidden, sendError,
  workspaceRepo, writeFileAtomic,
} from "./server-core.js";
import { parseAnswer } from "./server-companion.js";
import type { WsRouteCtx } from "./server-routes.js";

export async function handleBacklogRoutes(ctx: WsRouteCtx): Promise<boolean> {
  const { req, res, url, ws, opts } = ctx;
  const backlogDir = join(ws.workdir, "backlog");

  if (url.pathname === "/api/ticket/complete" && req.method === "POST") {
    // Expand a hand-written ticket into a proper Goal + Done-when body, on demand.
    try {
      const { title, notes } = await readJSON(req) as { title?: string; notes?: string };
      if (!title?.trim() && !notes?.trim()) throw new Error("write a title or a few notes first");
      const prompt = "You are drafting ONE work ticket for a coding agent working on this project. "
        + "Turn the rough note below into a crisp, single-scope ticket. Reply with GitHub-flavored "
        + "markdown ONLY (no preamble, no code fences): a \"## Goal\" section of 2-4 concrete sentences, "
        + "then a \"## Done when\" checklist of \"- \" acceptance items. Keep it to one focused change.\n\n"
        + `Rough title: ${title?.trim() || "(none)"}\nRough notes: ${notes?.trim() || "(none)"}`;
      const raw = await askOneShot(opts.factory, ws.workdir, prompt);
      const { text } = parseAnswer(raw);
      json(res, 200, { ok: true, body: text });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/ticket/review" && req.method === "POST") {
    // Opt-in companion review: a developer finished a MANUAL ticket by hand and
    // chose to have the AI check it. We hand the model the ticket plus the repo's
    // git diff (working changes, else the last commit) and ask for a review.
    try {
      const { file } = await readJSON(req) as { file?: string };
      if (!file?.trim()) throw new Error("file is required");
      const ticketPath = join(ws.workdir, "backlog", basename(file));
      if (!existsSync(ticketPath)) throw new Error("ticket not found");
      const content = readFileSync(ticketPath, "utf-8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
      const repoRaw = /^repo:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
      const repo = repoRaw ? resolve(repoRaw) : (workspaceRepo(ws) ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) throw new Error("no git repository to review");
      let diff = (await runCmd("git", ["diff", "HEAD"], repo)).output.trim();
      if (!diff) diff = (await runCmd("git", ["show", "-p", "--stat", "HEAD"], repo)).output.trim();
      diff = diff.slice(0, 28_000);
      const prompt = "A developer says they finished this ticket BY HAND (not the AI). Review their work "
        + "as a careful code reviewer: does it fulfil the ticket, and are there bugs, gaps, missing tests, "
        + "or risks? Be concise and concrete; if it looks solid, say so plainly. Do not take any action.\n\n"
        + `# Ticket\n${content}\n\n# Repository changes\n`
        + (diff || "(no diff found — review from the ticket intent and by reading the repo files)");
      const raw = await askOneShot(opts.factory, ws.workdir, prompt);
      const { text } = parseAnswer(raw);
      json(res, 200, { ok: true, review: text });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  if (url.pathname === "/api/tickets/hidden" && req.method === "GET") {
    json(res, 200, { hidden: [...ws.hidden] });
    return true;
  }
  if ((url.pathname === "/api/tickets/hide" || url.pathname === "/api/tickets/unhide") && req.method === "POST") {
    try {
      const { id } = await readJSON(req) as { id?: string };
      if (!id) throw new Error("id is required");
      if (url.pathname.endsWith("/hide")) ws.hidden.add(id); else ws.hidden.delete(id);
      saveHidden(ws);
      json(res, 200, { ok: true, hidden: [...ws.hidden] });
    } catch (err) { sendError(res, err); }
    return true;
  }
  if (url.pathname === "/api/backlog" && req.method === "GET") {
    const tickets = existsSync(backlogDir)
      ? readdirSync(backlogDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => ({ file: f, content: readFileSync(join(backlogDir, f), "utf-8") }))
      : [];
    json(res, 200, { tickets });
    return true;
  }

  if (url.pathname.startsWith("/api/backlog/")) {
    const file = basename(decodeURIComponent(url.pathname.slice("/api/backlog/".length)));
    if (!SAFE_NAME.test(file)) {
      json(res, 400, { ok: false, error: "bad ticket filename" });
      return true;
    }
    const path = join(backlogDir, file);
    // The client saves via postJSON (POST); accept PUT too for symmetry.
    if (req.method === "PUT" || req.method === "POST") {
      const { content } = await readJSON(req) as { content?: string };
      if (typeof content !== "string" || !content.startsWith("---")) {
        json(res, 400, { ok: false, error: "ticket must start with YAML front matter" });
        return true;
      }
      mkdirSync(backlogDir, { recursive: true });
      writeFileAtomic(path, content);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "DELETE") {
      if (existsSync(path)) unlinkSync(path);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (url.pathname === "/api/attachments" && req.method === "POST") {
    try {
      const body = await readJSON(req) as {
        dataUrl?: string; name?: string; content?: string;
      };

      // Case 1: Image upload (existing behavior) — workspace attachments for goals/tickets
      if (body.dataUrl) {
        const { dataUrl, name } = body;
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
        if (!m) throw new Error("expected a base64 image data URL");
        const buf = Buffer.from(m[2]!, "base64");
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
        const ext = m[1] === "jpeg" ? "jpg" : m[1]!;
        const dir = join(ws.workdir, "attachments");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${createHash("sha1").update(buf).digest("hex").slice(0, 10)}.${ext}`);
        writeFileSync(file, buf);
        json(res, 200, { path: file, name: name || basename(file) });
        return true;
      }

      // Case 2: File upload to run (new behavior) — supervisor companion attachments
      if (body.content !== undefined && body.name) {
        const { content, name } = body;
        if (!ws.tailer.run) throw new Error("no active run");

        // Validate filename (prevent directory traversal attacks)
        if (!name.trim()) throw new Error("filename cannot be empty");
        if (name.includes("..") || name.includes("/") || name.includes("\\")) {
          throw new Error("filename contains invalid path characters");
        }

        // Decode content: try base64 if it looks like base64, else treat as UTF-8
        let buf: Buffer;
        const trimmed = content.trim();
        if (/^[A-Za-z0-9+/=\n\r]*$/.test(trimmed)) {
          // Looks like base64 (or could be), try to decode
          try {
            buf = Buffer.from(trimmed, "base64");
          } catch {
            // Failed to decode as base64, treat as UTF-8
            buf = Buffer.from(content, "utf8");
          }
        } else {
          // Contains non-base64 characters, treat as UTF-8
          buf = Buffer.from(content, "utf8");
        }

        if (buf.length > MAX_UPLOAD_BYTES) throw new Error(`file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);

        const dir = join(ws.tailer.runsDir, ws.tailer.run, "uploads");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name);
        writeFileSync(file, buf);

        json(res, 200, { path: file, name });
        return true;
      }

      throw new Error("provide either dataUrl (for images) or name + content (for files)");
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  return false;
}
