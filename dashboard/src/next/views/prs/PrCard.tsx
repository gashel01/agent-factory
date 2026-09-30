/** One open pull request: its state in words (ready / conflicts / checking /
 *  draft), head → base, and the actions — Merge (gh pr merge --merge
 *  --delete-branch), Close (two-step), and the changes inline, read from the
 *  local clone (base..head) so reviewing never needs github.com. */

import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { PullRequest } from "../../../api-shapes.js";
import { ExternalLink, GitBranch, GitMerge, GitPullRequest } from "../../icons.js";
import { Btn, Spinner, Tag } from "../../ui.js";
import { DiffView } from "../repo/Code.js";
import { diffFailure, plainError } from "../repo/errors.js";
import { repoFetch } from "../repo/project-repo.js";
import { ConfirmBtn } from "./ConfirmBtn.js";

/** The list endpoint also returns createdAt (the classic type omits it). */
export type OpenPr = PullRequest & { createdAt?: string };

function state(pr: OpenPr): { text: string; color: string } {
  if (pr.isDraft) return { text: "Draft", color: "var(--st-queued)" };
  if (pr.mergeable === "MERGEABLE") return { text: "Ready to merge", color: "var(--st-merged)" };
  if (pr.mergeable === "CONFLICTING") return { text: "Conflicts", color: "var(--st-needs)" };
  return { text: "Checking mergeability…", color: "var(--st-review)" };
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function opened(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const mins = Math.round((t - Date.now()) / 60_000);
  if (Math.abs(mins) < 60) return RTF.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return RTF.format(hours, "hour");
  return RTF.format(Math.round(hours / 24), "day");
}

export function PrCard({ pr, repo, busy, locked, onAct }: {
  /** busy: this PR is being merged/closed; locked: any PR is. */
  pr: OpenPr; repo: string; busy: boolean; locked: boolean; onAct: (n: number, kind: "merge" | "close") => Promise<void>;
}): JSX.Element {
  const s = state(pr);
  const [diff, setDiff] = useState<{ text: string; error: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const toggleDiff = async (): Promise<void> => {
    if (showDiff) { setShowDiff(false); return; }
    setShowDiff(true);
    if (diff) return;
    try {
      const { diff: text } = await repoFetch<{ diff: string }>(repo, "diff", { from: pr.baseRefName, to: pr.headRefName });
      // A head branch that only exists on GitHub isn't in the local clone.
      setDiff(diffFailure(text)
        ? { text: "", error: `${pr.headRefName} isn't in your local clone — open the PR on GitHub to see its changes.` }
        : { text, error: "" });
    } catch (e) { setDiff({ text: "", error: plainError(e, "Couldn't load the changes.").text }); }
  };

  const when = opened(pr.createdAt);
  const mergeBlocked = pr.isDraft ? "A draft can't be merged — mark it ready on GitHub first."
    : pr.mergeable === "CONFLICTING" ? "Resolve the conflicts first." : undefined;
  return (
    <article className="card pr-card">
      <div className="pr-row">
        <span className="pr-icon" style={{ "--c": s.color } as CSSProperties} aria-hidden="true"><GitPullRequest size={19} /></span>
        <div className="stack pr-body">
          <div className="row pr-titleline">
            <a className="pr-num mono" href={pr.url} target="_blank" rel="noreferrer" aria-label={`Pull request ${pr.number} on GitHub`}>
              #{pr.number} <ExternalLink size={11} />
            </a>
            <b className="pr-title">{pr.title}</b>
          </div>
          <div className="row pr-meta">
            <Tag color={s.color} dot>{s.text}</Tag>
            <span className="faint pr-branchline"><GitBranch size={12} aria-hidden="true" /> <span className="mono">{pr.headRefName}</span> → <span className="mono">{pr.baseRefName}</span></span>
            {when && <span className="faint">opened {when}</span>}
          </div>
        </div>
        <div className="row pr-actions">
          <ConfirmBtn confirm="Close this PR?" onConfirm={() => onAct(pr.number, "close")} disabled={locked}>Close</ConfirmBtn>
          <Btn small onClick={toggleDiff}>{showDiff ? "Hide changes" : "View changes"}</Btn>
          <Btn small kind="fill" busy={busy} disabled={Boolean(mergeBlocked) || (locked && !busy)} title={mergeBlocked}
            onClick={() => onAct(pr.number, "merge")}><GitMerge size={13} /> Merge</Btn>
        </div>
      </div>
      {showDiff && (
        <div className="pr-diff">
          {diff === null ? <div className="rp-center"><Spinner /></div>
            : diff.error ? <p className="rp-note">{diff.error}</p>
              : <DiffView text={diff.text} empty={`${pr.headRefName} has nothing ${pr.baseRefName} doesn't already have.`} />}
        </div>
      )}
    </article>
  );
}
