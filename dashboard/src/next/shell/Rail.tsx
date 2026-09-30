/** The rail: every destination one click away, the project switcher on top, the
 *  plan window at the bottom. Replaces the classic toolbar, the "…" menu and the
 *  modals those opened. */

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  BookOpen, ChevronDown, GitBranch, GitPullRequest, Layers, Play, Rocket, Settings2, Sparkles, TrendingDown,
} from "../icons.js";
import { fmtReset, limitLabel, usePlanLimits } from "../../control.js";
import { useWarden } from "../data.js";
import type { Page } from "../routes.js";

function Link({ page, icon, children, count, hot }: {
  page: Page; icon: ReactNode; children: ReactNode; count?: number; hot?: boolean;
}): JSX.Element {
  const w = useWarden();
  const current = w.route.page === page || (page === "board" && w.route.page === "diff");
  return (
    <a className="rail-link" href={`#/${page}`} aria-current={current ? "page" : undefined}
      onClick={(e) => { e.preventDefault(); w.go(page); }}>
      {icon}<span className="rail-label">{children}</span>
      {count !== undefined && count > 0 && <span className={`rail-count${hot ? " hot" : ""}`}>{count}</span>}
    </a>
  );
}

function ProjectPicker(): JSX.Element {
  const w = useWarden();
  const [open, setOpen] = useState(false);
  const attention = w.visible.some((t) => t.state === "BLOCKED" || t.state === "FAILED");
  const dot = attention ? "var(--st-needs)" : w.live ? "var(--st-working)" : "var(--st-merged)";
  return (
    <>
      <button type="button" className="rail-project" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} title="Switch project">
        <span className="rail-project-dot" style={{ background: dot }} aria-hidden="true" />
        <span className="rail-project-name">{w.ws || "No project"}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <>
          <div className="scrim" style={{ background: "transparent", backdropFilter: "none" }} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="popover" role="menu" style={{ top: 118, left: 14, width: 250 }}>
            {w.workspaces.map((ws) => (
              <button key={ws.name} type="button" role="menuitem" className="menu-item" aria-selected={ws.name === w.ws}
                onClick={() => { w.switchWs(ws.name); setOpen(false); }}>
                <Layers size={16} />{ws.name}
              </button>
            ))}
            <div className="divider" style={{ margin: "6px 4px" }} />
            <button type="button" role="menuitem" className="menu-item" onClick={() => { w.go("projects"); setOpen(false); }}>
              <Sparkles size={16} />All projects
            </button>
          </div>
        </>
      )}
    </>
  );
}

function PlanCard(): JSX.Element {
  const w = useWarden();
  const limits = usePlanLimits(true);
  const session = limits.find((l) => l.kind === "session") ?? limits[0];
  const pct = session ? Math.round(session.percent) : null;
  const color = pct === null ? "var(--st-queued)" : pct >= 90 ? "var(--st-needs)" : pct >= 70 ? "var(--st-review)" : "var(--st-merged)";
  return (
    <button type="button" className="rail-plan" onClick={() => w.open({ type: "mode" })}
      title="How this project runs — execution mode, delivery, plan usage">
      <span className="rail-plan-row">
        <span>{session ? limitLabel(session) : w.model.mode === "api" ? "API key" : "Subscription"}</span>
        <span className="rail-plan-value">{pct === null ? "—" : `${pct}%`}</span>
      </span>
      <span className="bar"><span className="bar-seg" style={{ width: `${pct ?? 0}%`, background: color }} /></span>
      <span className="rail-plan-row">
        <span>{session?.resets_at ? `Resets ${fmtReset(session.resets_at)}` : "Plan usage"}</span>
        <span>{w.model.mode === "api" ? "API" : "Plan"}</span>
      </span>
    </button>
  );
}

export function Rail(): JSX.Element {
  const w = useWarden();
  const needsYou = w.visible.filter((t) => t.state === "BLOCKED" || t.state === "FAILED" || t.state === "AWAITING_APPROVAL").length;
  const onBoard = w.visible.filter((t) => t.state !== "DONE").length + w.pending.length;
  return (
    <nav className="rail" aria-label="Warden">
      <div className="rail-brand">
        <span className="rail-mark" aria-hidden="true"><span className="rail-mark-inner" /></span>
        <span><span className="rail-name">Warden</span><span className="rail-sub">Local execution</span></span>
      </div>
      <ProjectPicker />

      <span className="rail-group">Work</span>
      <Link page="board" icon={<Layers size={18} />} count={needsYou || onBoard} hot={needsYou > 0}>Board</Link>
      <Link page="prs" icon={<GitPullRequest size={18} />}>Pull requests</Link>
      <Link page="autopilot" icon={<Rocket size={18} />}>Autopilot</Link>

      <span className="rail-group">Project</span>
      <Link page="repo" icon={<GitBranch size={18} />}>Repository</Link>
      <Link page="knowledge" icon={<BookOpen size={18} />}>Knowledge</Link>
      <Link page="run" icon={<Play size={18} />}>Run &amp; preview</Link>
      <Link page="insights" icon={<TrendingDown size={18} />}>Insights</Link>

      <span className="rail-group">Warden</span>
      <Link page="memory" icon={<Sparkles size={18} />}>Memory</Link>
      <Link page="projects" icon={<Layers size={18} />}>All projects</Link>

      <div className="rail-foot">
        <PlanCard />
        <Link page="settings" icon={<Settings2 size={18} />}>Settings</Link>
      </div>
    </nav>
  );
}
