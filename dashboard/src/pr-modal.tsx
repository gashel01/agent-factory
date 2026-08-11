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
  const [prTitle, setPrTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [openingPr, setOpeningPr] = useState<string | null>(null); // branch whose inline PR form is open

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

  // The trunk every PR targets.
  const baseBranch = branches.list.includes("main") ? "main"
    : branches.list.includes("master") ? "master" : "main";
  // Opening a PR is a per-branch action: click it on a branch row and an inline
  // title field appears (prefilled from the branch name) — no head/base pickers,
  // because head IS that branch and base is the trunk. The 99% case, one gesture.
  const humanTitle = (b: string): string =>
    b.replace(/^\w+\//, "").replace(/[-_/]+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());
  const beginPr = (b: string): void => { setOpeningPr(b); setPrTitle(humanTitle(b)); };
  const createPr = async (head: string): Promise<void> => {
    const title = prTitle.trim();
    if (!head || !title || creating) return;
    setCreating(true);
    try {
      const r = await postJSON<{ ok?: boolean; url?: string; error?: string }>(
        "/api/prs/create", { repo, head, base: baseBranch, title },
      );
      if (r.ok) { toast(`PR opened for ${head}.`); setOpeningPr(null); setPrTitle(""); await load(repo); }
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

      {/* The review gate first, but only when there's something to review. */}
      {prs && prs.length > 0 && (
        <section className="pr-section">
          <h4 className="pr-h">Open pull requests <span className="pr-h-sub">— review and merge</span></h4>
          <ul className="pr-list">
            {prs.map((pr) => {
              const m = mergeable(pr.mergeable);
              return (
                <li key={pr.number} className="pr-row">
                  <div className="pr-main">
                    <a className="pr-num" href={pr.url} target="_blank" rel="noreferrer">#{pr.number} <ExternalLink size={11} /></a>
                    <span className="pr-title">{pr.title}</span>
                  </div>
                  <div className="pr-meta">
                    <span className="pr-branch"><GitBranch size={11} /> {pr.headRefName} → {pr.baseRefName}</span>
                    <span className={`pr-mergeable ${m.cls}`}>{pr.isDraft ? "draft" : m.text}</span>
                  </div>
                  <div className="pr-actions">
                    <Button kind="btn" variant="primary" pending={busy === pr.number}
                      disabled={pr.isDraft || pr.mergeable === "CONFLICTING" || busy !== null}
                      onClick={() => act(pr.number, "merge")}><GitMerge size={13} /> Merge</Button>
                    <ConfirmButton label="Close" confirm="Close PR?" onConfirm={() => act(pr.number, "close")} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Branches as the work you can act on — each row says what you can DO with
          it, rather than a wall of head/base/title fields and a lone deploy button. */}
      <section className="pr-section">
        <div className="pr-h-row">
          <h4 className="pr-h">Branches <span className="pr-h-sub">— open a PR, deploy, or switch</span></h4>
          <div className="branch-new-inline">
            <input className="branch-input" placeholder="New branch…" value={newBranch} aria-label="New branch name"
              onChange={(e) => setNewBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") void createBranch(); }} />
            <button className="branch-act" disabled={!newBranch.trim() || bBusy !== null} onClick={createBranch}><Plus size={13} /> New</button>
          </div>
        </div>

        {prs === null ? (
          <p className="pr-note">Loading…</p>
        ) : branches.list.length === 0 ? (
          <p className="pr-note">No branches yet.</p>
        ) : (
          <ul className="branch-rows">
            {branches.list.map((b) => {
              const cur = b === branches.current;
              const isBase = b === baseBranch;
              return (
                <li key={b} className={`branch-row${cur ? " current" : ""}`}>
                  <div className="branch-row-main">
                    <GitBranch size={13} className="branch-ic" />
                    <span className="branch-nm">{b}</span>
                    {cur && <span className="branch-tag cur">on it now</span>}
                    {isBase && <span className="branch-tag base">base</span>}
                  </div>
                  {openingPr === b ? (
                    <div className="branch-pr-form">
                      <input className="branch-input" autoFocus value={prTitle} placeholder="What does this deliver?"
                        aria-label="Pull request title" disabled={creating}
                        onChange={(e) => setPrTitle(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void createPr(b); if (e.key === "Escape") setOpeningPr(null); }} />
                      <Button kind="btn" variant="primary" pending={creating} disabled={!prTitle.trim() || creating}
                        onClick={() => createPr(b)}><GitMerge size={13} /> Open PR → {baseBranch}</Button>
                      <button className="branch-act ghost" onClick={() => setOpeningPr(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="branch-actions">
                      {!isBase && <button className="branch-act" disabled={bBusy !== null} onClick={() => beginPr(b)}><GitMerge size={13} /> Open PR</button>}
                      {cur && <ConfirmButton className="branch-act" label={<><RotateCw size={13} /> Deploy</>} confirm="Rebuild + restart?" onConfirm={deploy} />}
                      {!cur && <button className="branch-act" disabled={bBusy !== null} onClick={() => switchTo(b)}>Switch to</button>}
                      {!cur && !isBase && <ConfirmButton label={<Trash2 size={13} />} confirm="Delete?" plain onConfirm={() => delBranch(b)} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Modal>
  );
}
