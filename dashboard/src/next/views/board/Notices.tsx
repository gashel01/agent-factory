/** The notices that sit above the board, each silent unless it has something
 *  to say: the base branch's sync with its remote, the post-run integration
 *  check, the autopilot banner, and the oversized-file advisory ("Plan a
 *  split" hands the split to the AI through the New work sheet). Same data and
 *  wording as the classic SyncNote / IntegrationBanner / HotspotsPanel. */

import { useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { fetchJSON, setRepoPath } from "../../../api.js";
import type { Hotspot } from "../../../board-model.js";
import { inFlight } from "../../../model.js";
import type { TaskModel } from "../../../model.js";
import { useWarden } from "../../data.js";
import { ArrowDownToLine, ArrowUpFromLine, Check, InfinityIcon, RotateCw, TriangleAlert, X } from "../../icons.js";
import { Btn, IconBtn } from "../../ui.js";

function Notice({ color, icon, children, action }: { color: string; icon: ReactNode; children: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="bd-notice" role="note" style={{ "--c": color } as CSSProperties}>
      <span className="bd-notice-icon" aria-hidden="true">{icon}</span>
      <div className="bd-notice-body">{children}</div>
      {action}
    </div>
  );
}

export function SyncNotice(): JSX.Element | null {
  const sync = useWarden().model.sync;
  if (!sync || (sync.behind === 0 && sync.ahead === 0)) return null;
  const msg = sync.pulled
    ? `Base was ${sync.behind} commit${sync.behind > 1 ? "s" : ""} behind the remote — pulled to catch up.`
    : sync.behind > 0
      ? `Base is ${sync.behind} behind and ${sync.ahead} ahead of the remote (diverged) — not pulled; reconcile by hand.`
      : `Base is ${sync.ahead} commit${sync.ahead > 1 ? "s" : ""} ahead of the remote (unpushed).`;
  return (
    <Notice color={sync.pulled ? "var(--st-info)" : "var(--st-review)"}
      icon={sync.pulled ? <ArrowDownToLine size={16} /> : <ArrowUpFromLine size={16} />}>{msg}</Notice>
  );
}

export function IntegrationNotice(): JSX.Element | null {
  const { running, results } = useWarden().model.integration;
  if (!running && results.length === 0) return null;
  const failed = results.filter((r) => !r.ok);
  const color = running ? "var(--st-working)" : failed.length ? "var(--st-needs)" : "var(--st-merged)";
  return (
    <Notice color={color} icon={running ? <RotateCw size={16} /> : failed.length ? <X size={16} /> : <Check size={16} />}>
      <b>{running
        ? "Integration check running… (the full suite on the merged branch)"
        : failed.length
          ? "Integration check failed — the merged tickets don't hold together"
          : "Integration check passed — the merged tickets hold together"}</b>
      {failed.map((r, i) => (
        <div key={i} className="bd-integ-fail">
          <span className="mono">{r.repo.split(/[\\/]/).pop()}</span>
          <ul>{r.failures.map((f, j) => <li key={j}>{f}</li>)}</ul>
        </div>
      ))}
    </Notice>
  );
}

export function AutopilotNotice(): JSX.Element | null {
  const w = useWarden();
  if (!w.autopilot) return null;
  return (
    <Notice color="var(--st-info)" icon={<InfinityIcon size={16} />}
      action={<Btn small onClick={() => w.go("autopilot")}>Open autopilot</Btn>}>
      <b>Autopilot</b> <span className="dim">— these tickets are driven by the autopilot loop: it plans, runs and merges them on an integration branch.</span>
    </Notice>
  );
}

/** True when an in-flight ticket is already carving this file up: its title
 *  names the file (`cockpit.tsx`) or a sibling split module (`cockpit-…`). */
function beingSplit(path: string, tasks: TaskModel[], live: boolean): boolean {
  if (!live) return false;
  const stem = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
  if (!stem) return false;
  return tasks.some((t) => inFlight(t.state) && (t.title.toLowerCase().includes(`${stem}-`) || t.title.toLowerCase().includes(`${stem}.`)));
}

const splitGoal = (path: string): string =>
  `Split ${path} into smaller, cohesive modules. Pure mechanical refactor: `
  + `move code into new files and wire imports/exports — change no logic or behavior. `
  + `Keep the typecheck and the build green.`;

/** Advisory, never a gate: source files big enough that any ticket reading one
 *  pays a heavy token cost. Dismissible; silent when the repo is clean. */
export function HotspotNotice(): JSX.Element | null {
  const w = useWarden();
  const [spots, setSpots] = useState<Hotspot[] | null>(null);
  const [repo, setRepo] = useState("");
  const [dismissed, setDismissed] = useState(false);
  // The repo comes from the workspace itself (localStorage's repo path is empty
  // right after opening a project); refetch when the workspace changes.
  useEffect(() => {
    let alive = true;
    setSpots(null); setDismissed(false);
    void (async () => {
      try {
        const list = await fetchJSON<{ workspaces?: Array<{ name: string; repo: string | null }> }>("/api/workspaces");
        const r = (list.workspaces ?? []).find((x) => x.name === w.ws)?.repo ?? "";
        if (alive) setRepo(r);
        if (!r) { if (alive) setSpots([]); return; }
        const res = await fetchJSON<{ hotspots?: Hotspot[] }>(`/api/hotspots?repo=${encodeURIComponent(r)}`);
        if (alive) setSpots(res.hotspots ?? []);
      } catch { if (alive) setSpots([]); }
    })();
    return () => { alive = false; };
  }, [w.ws]);
  if (dismissed || !spots || spots.length === 0) return null;
  return (
    <Notice color="var(--st-review)" icon={<TriangleAlert size={16} />}
      action={<IconBtn small label="Dismiss" onClick={() => setDismissed(true)}><X size={15} /></IconBtn>}>
      <b>{spots.length} large file{spots.length > 1 ? "s" : ""} can weigh on tickets that touch them</b>
      <ul className="bd-hot-list">
        {spots.slice(0, 4).map((h) => (
          <li key={h.path} className="bd-hot">
            <button type="button" className="bd-hot-path mono" title={`Open ${h.path}`}
              onClick={() => { if (repo) setRepoPath(repo); w.go("repo", h.path); }}>{h.path}</button>
            <span className="faint">~{Math.round(h.estTokens / 1000)}k tokens · {h.edits} recent edits</span>
            <span className="spacer" />
            {beingSplit(h.path, w.tasks, w.live)
              ? <span className="faint" title="A ticket is already splitting this file">Splitting…</span>
              : <Btn small onClick={() => w.open({ type: "newwork", tab: "goal", goal: splitGoal(h.path), autostart: false })}>Plan a split</Btn>}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
