import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON, repoPath } from "./api.js";
import { toast } from "./core.js";
import { ExternalLink, GitBranch, GitMerge, Plus, RotateCw, Trash2 } from "./icons.js";
import { ConfirmButton, Modal } from "./widgets.js";
import { Button } from "./core.js";

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  isDraft: boolean;
}

/**
 * Closes the PR-mode loop inside Warden: lists the repo's open PRs and merges or
 * closes them from the board (via `gh`), instead of sending you to github.com.
 * Also shows the branch list. Resolves the repo from the current workspace, so it
 * works right after opening a project (repoPath() may still be empty then).
 */
export function PullRequestsModal({ ws, onClose }: { ws: string; onClose: () => void }): JSX.Element {
  const [repo, setRepo] = useState("");
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [branches, setBranches] = useState<{ list: string[]; current: string }>({ list: [], current: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [bBusy, setBBusy] = useState<string | null>(null); // branch name being acted on, or "__new__"
  const [prHead, setPrHead] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [prTitle, setPrTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const load = async (r: string): Promise<void> => {
    try {
      const p = await fetchJSON<{ prs?: PullRequest[]; error?: string }>(
        `/api/prs?repo=${encodeURIComponent(r)}`,
      );
      setPrs(p.prs ?? []);
      setErr(p.error ?? "");
    } catch { setPrs([]); setErr("could not reach the server"); }
    try {
      const b = await fetchJSON<{ branches?: string[]; current?: string }>(
        `/api/repo/branches?repo=${encodeURIComponent(r)}`,
      );
      setBranches({ list: b.branches ?? [], current: b.current ?? "" });
    } catch { /* branches are secondary */ }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let r = repoPath();
      if (!r) {
        try {
          const list = await fetchJSON<{ workspaces?: Array<{ name: string; repo: string | null }> }>(
            "/api/workspaces",
          );
          r = (list.workspaces ?? []).find((w) => w.name === ws)?.repo ?? "";
        } catch { /* */ }
      }
      if (!live) return;
      setRepo(r);
      if (r) await load(r);
      else { setPrs([]); setErr("no repository set for this project"); }
    })();
    return () => { live = false; };
  }, [ws]);

  const act = async (n: number, kind: "merge" | "close"): Promise<void> => {
    setBusy(n);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>(`/api/prs/${kind}`, { repo, number: n });
      if (r.ok) { toast(`PR #${n} ${kind === "merge" ? "merged" : "closed"}.`); await load(repo); }
      else toast(r.error || `could not ${kind} PR #${n}`, true);
    } catch (e) { toast(String(e), true); }
    finally { setBusy(null); }
  };

  // Branch actions — all guarded server-side (no switch/create/delete mid-run,
  // no deleting main or the current branch). bBusy locks the whole list.
  const switchTo = async (b: string): Promise<void> => {
    if (b === branches.current || bBusy) return;
    setBBusy(b);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/switch", { path: repo, branch: b });
      if (r.ok) { toast(`Now on ${b}.`); await load(repo); } else toast(r.error || "couldn't switch", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };
  const delBranch = async (b: string): Promise<void> => {
    setBBusy(b);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/branch/delete", { path: repo, branch: b });
      if (r.ok) { toast(`Deleted ${b}.`); await load(repo); } else toast(r.error || "couldn't delete", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };
  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim();
    if (!name || bBusy) return;
    setBBusy("__new__");
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/branch/create", { path: repo, branch: name });
      if (r.ok) { toast(`Created ${name}.`); setNewBranch(""); await load(repo); } else toast(r.error || "couldn't create", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };
  // Deploy the current branch onto the running Warden (rebuild + restart). The
  // server restarts mid-response, so the POST is expected to error — we reload
  // after a beat to pick up the fresh instance. Warden developing Warden.
  const deploy = async (): Promise<void> => {
    if (bBusy) return;
    setBBusy("__deploy__");
    toast(`Deploying ${branches.current} — rebuilding & restarting…`);
    try { await postJSON("/api/deploy", { branch: branches.current, restart: true }); }
    catch { /* connection drops as the server restarts — expected */ }
    setTimeout(() => { try { location.reload(); } catch { /* */ } }, 6000);
  };

  // Default the PR head to the branch you're on, so opening a PR for the work you
  // just finished is one click. Only seeds it once (don't fight a manual pick).
  useEffect(() => { setPrHead((h) => h || branches.current); }, [branches.current]);
  const createPr = async (): Promise<void> => {
    const head = prHead.trim(), base = prBase.trim() || "main", title = prTitle.trim();
    if (!head || !title || head === base || creating) return;
    setCreating(true);
    try {
      const r = await postJSON<{ ok?: boolean; url?: string; error?: string }>(
        "/api/prs/create", { repo, head, base, title },
      );
      if (r.ok) { toast(`PR opened: ${r.url ?? "done"}`); setPrTitle(""); await load(repo); }
      else toast(r.error || "couldn't open the PR", true);
    } catch (e) { toast(String(e), true); }
    finally { setCreating(false); }
  };

  const mergeable = (m: string): { text: string; cls: string } =>
    m === "MERGEABLE" ? { text: "ready", cls: "ok" }
      : m === "CONFLICTING" ? { text: "conflicts", cls: "bad" }
        : { text: "checking…", cls: "warn" };

  return (
    <Modal title="Pull requests" onClose={onClose} wide>
      {err && <p className="pr-note">{err}</p>}
      {prs === null ? (
        <p className="pr-note">Loading…</p>
      ) : prs.length === 0 ? (
        !err && <p className="pr-note">No open pull requests. When a run lands in PR mode, they show up here.</p>
      ) : (
        <ul className="pr-list">
          {prs.map((pr) => {
            const m = mergeable(pr.mergeable);
            return (
              <li key={pr.number} className="pr-row">
                <div className="pr-main">
                  <a className="pr-num" href={pr.url} target="_blank" rel="noreferrer">
                    #{pr.number} <ExternalLink size={11} />
                  </a>
                  <span className="pr-title">{pr.title}</span>
                </div>
                <div className="pr-meta">
                  <span className="pr-branch"><GitBranch size={11} /> {pr.headRefName} → {pr.baseRefName}</span>
                  <span className={`pr-mergeable ${m.cls}`}>{pr.isDraft ? "draft" : m.text}</span>
                </div>
                <div className="pr-actions">
                  <Button kind="btn" variant="primary" pending={busy === pr.number}
                    disabled={pr.isDraft || pr.mergeable === "CONFLICTING" || busy !== null}
                    onClick={() => act(pr.number, "merge")}>
                    <GitMerge size={13} /> Merge
                  </Button>
                  <ConfirmButton label="Close" confirm="Close PR?" onConfirm={() => act(pr.number, "close")} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="pr-new">
        <div className="pr-new-head"><GitMerge size={12} /> Open a pull request</div>
        <div className="pr-new-row">
          <select className="branch-input pr-new-head-sel" value={prHead} aria-label="Head branch"
            disabled={creating} onChange={(e) => setPrHead(e.currentTarget.value)}>
            {(branches.list.length ? branches.list : [branches.current]).filter(Boolean).map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <span className="pr-new-arrow">→</span>
          <input className="branch-input pr-new-base" value={prBase} aria-label="Base branch" placeholder="main"
            disabled={creating} onChange={(e) => setPrBase(e.currentTarget.value.replace(/[^\w./-]/g, ""))} />
        </div>
        <div className="pr-new-row">
          <input className="branch-input pr-new-title" value={prTitle} placeholder="Pull request title…"
            aria-label="Pull request title" disabled={creating}
            onChange={(e) => setPrTitle(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createPr(); }} />
          <Button kind="btn" variant="primary" pending={creating}
            disabled={!prHead.trim() || !prTitle.trim() || prHead === prBase.trim() || creating}
            onClick={createPr}><Plus size={13} /> Open PR</Button>
        </div>
      </div>
      {branches.current && (
        <div className="pr-deploy">
          <div className="pr-deploy-text">
            <b>Deploy to Warden</b> — rebuild <code>{branches.current}</code> and restart the running instance.
          </div>
          <ConfirmButton label={<><RotateCw size={13} /> Deploy</>} confirm="Rebuild + restart?"
            onConfirm={deploy} />
        </div>
      )}
      <div className="pr-branches">
        <div className="pr-branches-head"><GitBranch size={12} /> Branches</div>
        <div className="branch-new">
          <input className="branch-input" placeholder="New branch name…" value={newBranch}
            aria-label="New branch name"
            onChange={(e) => setNewBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") void createBranch(); }} />
          <Button kind="btn" pending={bBusy === "__new__"} disabled={!newBranch.trim() || bBusy !== null}
            onClick={createBranch}><Plus size={13} /> Create</Button>
        </div>
        {branches.list.length === 0 ? (
          <span className="pr-note">—</span>
        ) : (
          <ul className="branch-list">
            {branches.list.map((b) => {
              const cur = b === branches.current;
              const locked = b === "main" || b === "master";
              return (
                <li key={b} className={cur ? "cur" : ""}>
                  <button className="branch-name" disabled={cur || bBusy !== null}
                    title={cur ? "Current branch" : `Switch to ${b}`} onClick={() => switchTo(b)}>
                    {b}{cur ? " · current" : ""}
                  </button>
                  {!cur && !locked && (
                    <ConfirmButton label={<Trash2 size={13} />} confirm="Delete?"
                      plain onConfirm={() => delBranch(b)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
