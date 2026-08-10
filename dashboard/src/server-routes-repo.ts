/* Extracted from server.ts — mechanical split. Workspace-independent, path-based
 * repo tools: init/publish/visibility, the read-only git explorer (tree/file/
 * branches/log/diff), and the guarded branch switch. Runs before per-workspace
 * resolution. (The per-workspace /api/repo/path lives with the workspace routes.) */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { json, readBody, runCmd, runShell } from "./server-core.js";
import { BOOTSTRAP_GITIGNORE } from "./server-preview.js";
import type { RouteCtx } from "./server-routes.js";

/** Run `gh` capturing stdout SEPARATELY from stderr, so `--json` output parses
 *  cleanly (runCmd merges the two, and gh's notices would corrupt the JSON). */
function ghJson(args: string[], cwd: string): Promise<{ ok: boolean; data: unknown; err: string }> {
  return new Promise((res) => {
    const child = spawn("gh", args, { cwd, shell: false, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => res({ ok: false, data: null, err: String(e) }));
    child.on("exit", (code) => {
      if (code !== 0) return res({ ok: false, data: null, err: (err || out).trim() });
      try { res({ ok: true, data: JSON.parse(out || "[]"), err: "" }); }
      catch { res({ ok: false, data: null, err: "unreadable gh output" }); }
    });
  });
}

export async function handleRepoRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, registry, opts } = ctx;

  // Deploy: put a branch of Warden's OWN source live on the running instance —
  // checkout + rebuild, optionally restarting to pick up server-side changes.
  // Closes the "Warden develops Warden" loop without dropping to a terminal.
  if (url.pathname === "/api/deploy" && req.method === "POST") {
    try {
      const { branch, restart } = JSON.parse(await readBody(req)) as
        { branch?: string; restart?: boolean };
      const dashDir = process.cwd();          // server is launched from dashboard/
      const repoRoot = resolve(dashDir, "..");
      if (!existsSync(join(repoRoot, ".git")) || !existsSync(join(dashDir, "package.json"))) {
        throw new Error("deploy only works when Warden runs from its own source tree");
      }
      if (branch && !/^[\w./-]+$/.test(branch)) throw new Error("bad branch name");
      // A restart kills any spawned run/loop subprocess, so refuse while one is
      // live — otherwise a deploy would abort a run mid-flight (surfacing as a
      // spurious "killed by the operator").
      const busy = [...registry.workspaces.values()].find(
        (w) => w.jobs.run.state === "running" || w.jobs.loop.state === "running",
      );
      if (restart && busy) {
        throw new Error(`a run is active on '${busy.name}' — stop it before deploying (a restart would kill it)`);
      }
      const dirty = (await runCmd("git", ["status", "--porcelain"], repoRoot)).output.trim();
      if (branch && dirty) {
        throw new Error("uncommitted changes in the source tree — commit or stash before deploying a branch");
      }
      if (branch) {
        const co = await runCmd("git", ["checkout", branch], repoRoot);
        if (co.code !== 0) throw new Error("checkout failed: " + (co.output.trim() || branch));
      }
      const build = await runShell(
        "npm install --prefer-offline --no-audit --no-fund && npm run build", dashDir,
      );
      if (build.code !== 0) throw new Error("build failed: " + build.output.slice(-800));
      if (restart) {
        // Detached respawn. Instead of a fixed timer (which races the old server's
        // port release → EADDRINUSE → no server), poll the port and start the new
        // server the instant it frees. Retries the probe for ~15s, then starts
        // best-effort so a stuck exit never leaves us permanently down.
        const relaunch =
          `const net=require("net"),cp=require("child_process");let n=0;` +
          `const start=()=>cp.spawn(process.execPath,["dist/server.js","--port","${opts.port}","--host","${opts.host}"],` +
          `{cwd:${JSON.stringify(dashDir)},detached:true,stdio:"ignore"}).unref();` +
          `const tick=()=>{const s=net.connect(${opts.port},"127.0.0.1");` +
          `s.once("connect",()=>{s.destroy();(++n<60)?setTimeout(tick,250):start();});` +
          `s.once("error",()=>{s.destroy();start();});};setTimeout(tick,300);`;
        spawn(process.execPath, ["-e", relaunch], { detached: true, stdio: "ignore" }).unref();
        json(res, 200, { ok: true, restarting: true, log: build.output.slice(-400) });
        setTimeout(() => process.exit(0), 600);
        return true;
      }
      json(res, 200, { ok: true, restarting: false, log: build.output.slice(-400) });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/repo/init" && req.method === "POST") {
    try {
      const { path } = JSON.parse(await readBody(req)) as { path?: string };
      if (!path?.trim()) throw new Error("path is required");
      const dir = resolve(path.trim());
      if (existsSync(join(dir, ".git"))) throw new Error("already a git repository");
      mkdirSync(dir, { recursive: true });
      const init = await runCmd("git", ["init", "-b", "main"], dir);
      if (init.code !== 0) throw new Error(init.output.trim());
      if (!existsSync(join(dir, ".gitignore"))) {
        writeFileSync(join(dir, ".gitignore"), BOOTSTRAP_GITIGNORE, "utf-8");
      }
      await runCmd("git", ["add", "-A"], dir);
      const commit = await runCmd(
        "git",
        ["commit", "-m", "chore: initial commit (agent-factory bootstrap)"],
        dir,
      );
      if (commit.code !== 0) throw new Error(commit.output.trim());
      json(res, 200, { ok: true, output: `initialized ${dir} on branch main` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/repo/publish" && req.method === "POST") {
    try {
      const { path, visibility } = JSON.parse(await readBody(req)) as {
        path?: string;
        visibility?: string;
      };
      if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
        throw new Error("path must be an existing git repository");
      }
      if (visibility !== "private" && visibility !== "public") {
        throw new Error("visibility must be private or public");
      }
      const dir = resolve(path.trim());
      const result = await runCmd(
        "gh",
        ["repo", "create", basename(dir), `--${visibility}`, "--source=.", "--push"],
        dir,
      );
      if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
      json(res, 200, { ok: true, output: result.output.trim() });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname === "/api/repo/visibility" && req.method === "POST") {
    try {
      const { path, visibility } = JSON.parse(await readBody(req)) as {
        path?: string;
        visibility?: string;
      };
      if (!path?.trim() || !existsSync(join(resolve(path.trim()), ".git"))) {
        throw new Error("path must be an existing git repository");
      }
      if (visibility !== "private" && visibility !== "public") {
        throw new Error("visibility must be private or public");
      }
      const dir = resolve(path.trim());
      // Newer gh requires an explicit consent flag for visibility changes;
      // older gh rejects it as unknown — try with, fall back without.
      let result = await runCmd(
        "gh",
        ["repo", "edit", "--visibility", visibility, "--accept-visibility-change-consequences"],
        dir,
      );
      if (result.code !== 0 && /unknown flag/i.test(result.output)) {
        result = await runCmd("gh", ["repo", "edit", "--visibility", visibility], dir);
      }
      if (result.code !== 0) throw new Error(result.output.trim() || "gh failed — is it installed and logged in?");
      json(res, 200, { ok: true, output: result.output.trim() || `repository is now ${visibility}` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if (url.pathname.startsWith("/api/repo/") && req.method === "GET") {
    const repo = resolve(url.searchParams.get("repo") ?? "");
    if (!repo || !existsSync(join(repo, ".git"))) {
      json(res, 400, { ok: false, error: "repo must be an existing git repository" });
      return true;
    }
    const ref = url.searchParams.get("ref") ?? "HEAD";
    if (!/^[\w./@^~-]+$/.test(ref)) {
      json(res, 400, { ok: false, error: "bad ref" });
      return true;
    }

    if (url.pathname === "/api/repo/tree") {
      const result = await runCmd("git", ["ls-tree", "-r", "--name-only", ref], repo);
      if (result.code !== 0) {
        json(res, 400, { ok: false, error: result.output.trim() });
        return true;
      }
      json(res, 200, { files: result.output.split("\n").filter(Boolean) });
      return true;
    }
    if (url.pathname === "/api/repo/file") {
      const file = url.searchParams.get("path") ?? "";
      if (!file || file.includes("..")) {
        json(res, 400, { ok: false, error: "bad path" });
        return true;
      }
      const result = await runCmd("git", ["show", `${ref}:${file}`], repo);
      if (result.code !== 0) {
        json(res, 404, { ok: false, error: result.output.trim() });
        return true;
      }
      json(res, 200, { content: result.output.slice(0, 200_000), path: file });
      return true;
    }
    if (url.pathname === "/api/repo/branches") {
      const branches = await runCmd("git", ["branch", "--format=%(refname:short)"], repo);
      const current = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
      json(res, 200, {
        branches: branches.output.split("\n").filter(Boolean),
        current: current.output.trim(),
      });
      return true;
    }
    if (url.pathname === "/api/repo/log") {
      const result = await runCmd(
        "git",
        ["log", "--format=%h%x09%ad%x09%an%x09%s", "--date=relative", "-n", "60", ref],
        repo,
      );
      const commits = result.output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, ...subject] = line.split("\t");
          return { hash, date, author, subject: subject.join("\t") };
        });
      json(res, 200, { commits });
      return true;
    }
    if (url.pathname === "/api/repo/diff") {
      // ?commit=<hash> shows one commit; ?from=&to= compares two refs
      const commit = url.searchParams.get("commit");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      let args: string[];
      if (commit && /^[\w^~]+$/.test(commit)) {
        args = ["show", commit, "--stat", "--patch"];
      } else if (from && to && /^[\w./@^~-]+$/.test(from) && /^[\w./@^~-]+$/.test(to)) {
        args = ["diff", `${from}..${to}`, "--stat", "--patch"];
      } else {
        json(res, 400, { ok: false, error: "pass ?commit= or ?from=&to=" });
        return true;
      }
      const result = await runCmd("git", args, repo);
      json(res, 200, { diff: result.output.slice(0, 400_000) });
      return true;
    }
    // A GET /api/repo/<unknown> with a valid repo falls through to workspace
    // resolution and, ultimately, the 404 — exactly as before the split.
  }

  if (url.pathname === "/api/repo/switch" && req.method === "POST") {
    try {
      const { path, branch } = JSON.parse(await readBody(req)) as {
        path?: string;
        branch?: string;
      };
      const repo = resolve(path ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) {
        throw new Error("repo must be an existing git repository");
      }
      if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error("bad branch name");
      // A run's merge queue targets the checked-out branch: never switch mid-run.
      const running = [...registry.workspaces.values()].some(
        (w) => w.jobs.run.state === "running",
      );
      if (running) throw new Error("refusing to switch branches while a run is in progress");
      const result = await runCmd("git", ["switch", branch], repo);
      if (result.code !== 0) throw new Error(result.output.trim());
      json(res, 200, { ok: true, output: `now on ${branch}` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  // Create a branch and switch to it (optionally from a start-point). Same
  // run-in-progress guard as switch, since it moves HEAD.
  if (url.pathname === "/api/repo/branch/create" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string; branch?: string; from?: string };
      const repo = resolve(body.path ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) throw new Error("repo must be an existing git repository");
      if (!body.branch || !/^[\w./-]+$/.test(body.branch)) throw new Error("bad branch name");
      const from = typeof body.from === "string" && /^[\w./-]+$/.test(body.from) ? body.from : null;
      const running = [...registry.workspaces.values()].some((w) => w.jobs.run.state === "running");
      if (running) throw new Error("refusing to create/switch branches while a run is in progress");
      const args = from ? ["switch", "-c", body.branch, from] : ["switch", "-c", body.branch];
      const result = await runCmd("git", args, repo);
      if (result.code !== 0) throw new Error(result.output.trim());
      json(res, 200, { ok: true, output: `created and switched to ${body.branch}` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  // Delete a branch (force). Human-initiated only; refuses main, the current
  // branch, and any delete while a run is in progress (the merge queue targets
  // live branches).
  if (url.pathname === "/api/repo/branch/delete" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string; branch?: string };
      const repo = resolve(body.path ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) throw new Error("repo must be an existing git repository");
      if (!body.branch || !/^[\w./-]+$/.test(body.branch)) throw new Error("bad branch name");
      if (body.branch === "main" || body.branch === "master") throw new Error("won't delete the default branch");
      const current = (await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo)).output.trim();
      if (body.branch === current) throw new Error("can't delete the current branch — switch away first");
      const running = [...registry.workspaces.values()].some((w) => w.jobs.run.state === "running");
      if (running) throw new Error("refusing to delete branches while a run is in progress");
      // Loop iterations leave the branch checked out in a disposable worktree
      // under <repo>/.factory/ — git then refuses `branch -D`. Remove ONLY such
      // Warden-managed worktrees (never a real one elsewhere) and retry.
      const posix = (p: string): string => p.split(/[\\/]/).join("/");
      const factoryDir = posix(join(repo, ".factory")) + "/";
      const wt = await runCmd("git", ["worktree", "list", "--porcelain"], repo);
      let curPath = "";
      for (const line of wt.output.split("\n")) {
        if (line.startsWith("worktree ")) curPath = posix(line.slice("worktree ".length).trim());
        else if (line.startsWith("branch ") && line.trim() === `branch refs/heads/${body.branch}`
          && curPath.startsWith(factoryDir)) {
          await runCmd("git", ["worktree", "remove", "--force", curPath], repo);
        }
      }
      await runCmd("git", ["worktree", "prune"], repo);
      const result = await runCmd("git", ["branch", "-D", body.branch], repo);
      if (result.code !== 0) throw new Error(result.output.trim());
      json(res, 200, { ok: true, output: `deleted ${body.branch}` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  // Pull requests (GitHub, via gh) — list open PRs and merge/close them from the
  // board, so PR mode's loop closes inside Warden instead of on github.com.
  if (url.pathname === "/api/prs" && req.method === "GET") {
    const repo = resolve(url.searchParams.get("repo") ?? "");
    if (!repo || !existsSync(join(repo, ".git"))) {
      json(res, 400, { prs: [], error: "repo must be an existing git repository" });
      return true;
    }
    const r = await ghJson(
      ["pr", "list", "--state", "open", "--limit", "30",
       "--json", "number,title,headRefName,baseRefName,url,mergeable,isDraft,createdAt"],
      repo,
    );
    // Degrade softly: no gh / not a GitHub remote just means "no PRs to show".
    json(res, 200, r.ok ? { prs: r.data } : { prs: [], error: r.err || "gh unavailable" });
    return true;
  }

  if (url.pathname === "/api/prs/create" && req.method === "POST") {
    try {
      const { repo: repoIn, head, base, title, body } = JSON.parse(await readBody(req)) as
        { repo?: string; head?: string; base?: string; title?: string; body?: string };
      const repo = resolve(repoIn ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) throw new Error("bad repo");
      const nameRe = /^[\w./-]+$/;
      if (!head || !nameRe.test(head)) throw new Error("bad head branch");
      const baseBranch = base && nameRe.test(base) ? base : "main";
      if (head === baseBranch) throw new Error("head and base branches must differ");
      if (!title || !title.trim()) throw new Error("a title is required");
      // A PR needs the branch on the remote: push it (upstream-tracking) first,
      // then open the PR. force-with-lease so re-opening after new commits is safe
      // without clobbering someone else's push.
      const push = await runCmd("git", ["push", "--force-with-lease", "-u", "origin", head], repo);
      if (push.code !== 0) throw new Error("push failed: " + (push.output.trim() || "git push error"));
      const result = await runCmd(
        "gh",
        ["pr", "create", "--head", head, "--base", baseBranch, "--title", title.trim(),
         "--body", (body ?? "").trim()],
        repo,
      );
      if (result.code !== 0) throw new Error(result.output.trim() || "gh pr create failed");
      json(res, 200, { ok: true, url: result.output.trim() });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  if ((url.pathname === "/api/prs/merge" || url.pathname === "/api/prs/close")
      && req.method === "POST") {
    try {
      const { repo: repoIn, number } = JSON.parse(await readBody(req)) as {
        repo?: string; number?: number;
      };
      const repo = resolve(repoIn ?? "");
      if (!repo || !existsSync(join(repo, ".git"))) throw new Error("bad repo");
      if (!Number.isInteger(number) || (number as number) <= 0) throw new Error("bad PR number");
      const args = url.pathname.endsWith("/merge")
        ? ["pr", "merge", String(number), "--merge", "--delete-branch"]
        : ["pr", "close", String(number)];
      const result = await runCmd("gh", args, repo);
      if (result.code !== 0) throw new Error(result.output.trim() || "gh command failed");
      json(res, 200, { ok: true, output: result.output.trim() });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return true;
  }

  return false;
}
