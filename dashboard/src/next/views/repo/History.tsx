/** The History tab: every branch as a coloured railroad of commits (or one
 *  branch's line), a commit's diff on the right, and a two-click compare —
 *  "Compare from here" arms a base, the next commit picked is the target.
 *  Same endpoints as the classic modal: /api/repo/log (all=1 | ref) and
 *  /api/repo/diff (commit= | from=&to=). */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Commit } from "../../../repo-model.js";
import { GitBranch, GitCommitHorizontal } from "../../icons.js";
import { Btn, Empty, Spinner } from "../../ui.js";
import { DiffView } from "./Code.js";
import { plainError } from "./errors.js";
import { DOT_R, LANE_W, ROW_H, computeGraph, refLabel } from "./graph.js";
import { repoFetch } from "./project-repo.js";

type Shown =
  | { kind: "commit"; commit: Commit }
  | { kind: "range"; from: string; to: string };

function Timeline({ commits, active, anchor, onPick }: {
  commits: Commit[]; active: string | null; anchor: string | null; onPick: (c: Commit) => void;
}): JSX.Element {
  const rows = computeGraph(commits);
  const gw = Math.max(...rows.map((r) => r.lanes), 1) * LANE_W;
  return (
    <div className="rp-graph">
      {rows.map((r) => {
        const c = r.commit;
        const tip = [c.subject, c.body, `${c.hash} · ${c.author} · ${c.date}`].filter(Boolean).join("\n\n");
        return (
          <button key={c.hash} type="button" className="rp-graph-row" title={tip}
            aria-current={active === c.hash ? "true" : undefined} data-anchor={anchor === c.hash || undefined}
            onClick={() => onPick(c)}>
            <svg width={gw} height={ROW_H} viewBox={`0 0 ${gw} ${ROW_H}`} aria-hidden="true" className="rp-graph-rail">
              {r.segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={2} strokeLinecap="round" />)}
              <circle cx={r.col * LANE_W + LANE_W / 2} cy={ROW_H / 2} r={DOT_R} fill="var(--card)" stroke={r.dotColor} strokeWidth={2.5} />
            </svg>
            <span className="rp-graph-text">
              <span className="rp-graph-subject">
                {c.refs.map(refLabel).filter((x) => x !== null).map((rl, i) => (
                  <span key={i} className={`rp-ref ${rl.kind}`}>{rl.text}</span>
                ))}
                {c.subject}
              </span>
              <span className="rp-graph-meta">{c.hash} · {c.author} · {c.date}</span>
            </span>
            {anchor === c.hash && <span className="tag">base</span>}
          </button>
        );
      })}
    </div>
  );
}

export function History({ repo, branches, version }: { repo: string; branches: string[]; version: number }): JSX.Element {
  const [scope, setScope] = useState(""); // "" = every branch
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [logErr, setLogErr] = useState("");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [diff, setDiff] = useState<{ text: string; error: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setCommits(null);
    const params: Record<string, string> = scope ? { ref: scope } : { all: "1" };
    repoFetch<{ commits: Commit[] }>(repo, "log", params)
      .then((r) => { if (alive) { setCommits(r.commits); setLogErr(""); } })
      .catch((e) => { if (alive) { setCommits([]); setLogErr(plainError(e, "Couldn't read the history.").text); } });
    return () => { alive = false; };
  }, [repo, scope, version]);

  const load = async (next: Shown, params: Record<string, string>): Promise<void> => {
    setShown(next);
    setDiff(null);
    try {
      const { diff: text } = await repoFetch<{ diff: string }>(repo, "diff", params);
      setDiff({ text, error: "" });
    } catch (e) {
      setDiff({ text: "", error: plainError(e, "Couldn't load this diff.").text });
    }
  };
  const pick = (c: Commit): void => {
    if (anchor && anchor !== c.hash) {
      const from = anchor;
      setAnchor(null);
      void load({ kind: "range", from, to: c.hash }, { from, to: c.hash });
    } else void load({ kind: "commit", commit: c }, { commit: c.hash });
  };

  const activeHash = shown?.kind === "commit" ? shown.commit.hash : shown?.kind === "range" ? shown.to : null;
  return (
    <div className="rp-split">
      <section className="card rp-side">
        <label className="rp-scope">
          <GitBranch size={14} aria-hidden="true" />
          <select className="rp-select" value={scope} onChange={(e) => setScope(e.currentTarget.value)} aria-label="Timeline scope">
            <option value="">All branches</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        {anchor && (
          <div className="rp-compare" role="status">
            <span>Comparing from <span className="mono">{anchor}</span> — pick the target commit.</span>
            <Btn small kind="ghost" onClick={() => setAnchor(null)}>Cancel</Btn>
          </div>
        )}
        {commits === null ? <div className="rp-center"><Spinner /></div>
          : logErr ? <p className="rp-note">{logErr}</p>
            : commits.length === 0 ? <p className="hint">No commits yet.</p>
              : <Timeline commits={commits} active={activeHash} anchor={anchor} onPick={pick} />}
      </section>

      <section className="stack rp-main">
        {!shown ? (
          <Empty icon={<GitCommitHorizontal size={22} />} title="Pick a commit">
            Its changes show here. To compare two commits, open the first, choose “Compare from here”, then pick the second.
          </Empty>
        ) : (
          <>
            <div className="rp-filebar">
              {shown.kind === "commit" ? (
                <div className="stack rp-commit-head">
                  <b>{shown.commit.subject}</b>
                  <span className="faint rp-small"><span className="mono">{shown.commit.hash}</span> · {shown.commit.author} · {shown.commit.date}</span>
                </div>
              ) : (
                <span className="rp-commit-head">Comparing <span className="mono">{shown.from}</span> → <span className="mono">{shown.to}</span></span>
              )}
              <div className="spacer" />
              {shown.kind === "commit" && (
                <Btn small onClick={() => setAnchor(shown.commit.hash)} disabled={anchor === shown.commit.hash}>Compare from here</Btn>
              )}
            </div>
            {diff === null ? <div className="rp-center"><Spinner /></div>
              : diff.error ? <p className="rp-note">{diff.error}</p>
                : <DiffView text={diff.text} empty={shown.kind === "range" ? "These two commits are identical." : "This commit changes no files."} />}
          </>
        )}
      </section>
    </div>
  );
}
