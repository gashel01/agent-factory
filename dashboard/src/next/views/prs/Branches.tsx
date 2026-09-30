/** Branches as work you can act on: open a PR from a branch (head = that
 *  branch, base = the trunk, title prefilled from its name — one gesture), switch
 *  to it, delete it, create a new one, or deploy the checked-out branch onto the
 *  running Warden. Every guard is server-side (no switch/create/delete mid-run,
 *  never delete main or the current branch); this only reports them plainly. */

import { useState } from "react";
import type { JSX } from "react";
import { postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { GitBranch, GitMerge, Plus, RotateCw } from "../../icons.js";
import { Btn, Tag } from "../../ui.js";
import { plainError } from "../repo/errors.js";
import { ConfirmBtn } from "./ConfirmBtn.js";

/** After asking for a deploy, the server restarts mid-response: reload after this. */
const DEPLOY_RELOAD_MS = 6000;

/** "feat/add-login_page" → "Add login page". */
const humanTitle = (b: string): string =>
  b.replace(/^\w+\//, "").replace(/[-_/]+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());

export function Branches({ repo, list, current, onChanged }: {
  repo: string; list: string[]; current: string; onChanged: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null); // branch acted on, "__new__", "__deploy__"
  const [newBranch, setNewBranch] = useState("");
  const [openingPr, setOpeningPr] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const base = list.includes("main") ? "main" : list.includes("master") ? "master" : "main";

  /** Run one branch action, toasting the outcome in plain words. */
  const act = async (key: string, url: string, body: object, done: string, fail: string): Promise<boolean> => {
    setBusy(key);
    try {
      await postJSON(url, body);
      toast(done);
      await onChanged();
      return true;
    } catch (e) { toast(plainError(e, fail).text, true); return false; }
    finally { setBusy(null); }
  };

  const create = async (): Promise<void> => {
    const name = newBranch.trim();
    if (!name || busy) return;
    if (await act("__new__", "/api/repo/branch/create", { path: repo, branch: name }, `Created ${name} — you're on it now.`, `Couldn't create ${name}.`)) setNewBranch("");
  };
  const openPr = async (head: string): Promise<void> => {
    const title = prTitle.trim();
    if (!title) return;
    if (await act(head, "/api/prs/create", { repo, head, base, title }, `PR opened for ${head}.`, "Couldn't open the pull request.")) {
      setOpeningPr(null); setPrTitle("");
    }
  };
  // Deploy: rebuild + restart Warden on the checked-out branch. The connection
  // drops as the server restarts, so a failed POST is expected; reload after a beat.
  const deploy = async (): Promise<void> => {
    setBusy("__deploy__");
    toast(`Deploying ${current} — rebuilding and restarting…`);
    try { await postJSON("/api/deploy", { branch: current, restart: true }); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A refusal (run in progress, dirty tree, not Warden's own source) comes back as JSON before any restart.
      if (/run is active|uncommitted|only works when|build failed|checkout failed/i.test(msg)) {
        setBusy(null);
        toast(plainError(e, "Couldn't deploy.").text, true);
        return;
      }
    }
    setTimeout(() => { location.reload(); }, DEPLOY_RELOAD_MS);
  };

  return (
    <section className="card pr-branches" aria-labelledby="pr-branches-h">
      <div className="row pr-branches-head">
        <div className="stack pr-gap-2">
          <h2 id="pr-branches-h" className="card-title">Branches</h2>
          <p className="hint">Open a PR from a branch, switch to it, or deploy the one you're on.</p>
        </div>
        <div className="spacer" />
        <form className="row pr-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input className="input pr-new-input" placeholder="New branch…" value={newBranch} aria-label="New branch name"
            onChange={(e) => setNewBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))} />
          <Btn small disabled={!newBranch.trim() || busy !== null} onClick={create}><Plus size={13} /> New</Btn>
        </form>
      </div>
      {list.length === 0 ? <p className="hint">No branches yet.</p> : (
        <ul className="pr-blist">
          {list.map((b) => {
            const cur = b === current;
            const isBase = b === base;
            return (
              <li key={b} className="pr-brow" aria-current={cur ? "true" : undefined}>
                <div className="row pr-bname">
                  <GitBranch size={14} aria-hidden="true" />
                  <span className="mono">{b}</span>
                  {cur && <Tag color="var(--st-working)" dot>checked out</Tag>}
                  {isBase && <Tag>base</Tag>}
                </div>
                {openingPr === b ? (
                  <form className="row pr-openform" onSubmit={(e) => { e.preventDefault(); void openPr(b); }}>
                    <input className="input pr-new-input" autoFocus value={prTitle} placeholder="What does this deliver?"
                      aria-label="Pull request title" disabled={busy === b}
                      onChange={(e) => setPrTitle(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpeningPr(null); } }} />
                    <Btn small kind="fill" busy={busy === b} disabled={!prTitle.trim()} onClick={() => openPr(b)}>
                      <GitMerge size={13} /> Open PR → {base}
                    </Btn>
                    <Btn small kind="ghost" onClick={() => setOpeningPr(null)}>Cancel</Btn>
                  </form>
                ) : (
                  <div className="row pr-bactions">
                    {!isBase && <Btn small disabled={busy !== null} onClick={() => { setOpeningPr(b); setPrTitle(humanTitle(b)); }}><GitMerge size={13} /> Open PR</Btn>}
                    {cur && (
                      <ConfirmBtn kind="default" confirm="Rebuild and restart?" disabled={busy !== null} onConfirm={deploy}
                        label="Rebuild Warden from this branch and restart it (only when Warden runs from its own source)">
                        <RotateCw size={13} /> Deploy
                      </ConfirmBtn>
                    )}
                    {!cur && <Btn small disabled={busy !== null}
                      onClick={() => act(b, "/api/repo/switch", { path: repo, branch: b }, `Now on ${b}.`, `Couldn't switch to ${b}.`)}>Switch to</Btn>}
                    {!cur && !isBase && (
                      <ConfirmBtn confirm="Delete it?" disabled={busy !== null}
                        onConfirm={() => act(b, "/api/repo/branch/delete", { path: repo, branch: b }, `Deleted ${b}.`, `Couldn't delete ${b}.`)}>
                        Delete
                      </ConfirmBtn>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
