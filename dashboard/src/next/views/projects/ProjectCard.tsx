/** One project on the Projects page: its status, the shape of its board (a
 *  stacked bar + four counts), its budget if it has a cap, when it last moved.
 *  The name is the card's main button (its hit area covers the whole card), so
 *  the card opens with a click anywhere while "…" and Open stay real buttons. */

import type { CSSProperties, JSX } from "react";
import { ago, fmtUsd } from "../../../model.js";
import { Layers, MoreHorizontal } from "../../icons.js";
import { Bar, Btn, IconBtn, Tag } from "../../ui.js";
import { baseName, projectStatus } from "./portfolio.js";
import type { PortfolioProject } from "./portfolio.js";

function Metric({ n, label, color }: { n: number; label: string; color?: string }): JSX.Element {
  return (
    <div className="pj-metric">
      <span className="pj-metric-n" style={{ color: n > 0 ? color ?? "var(--text)" : "var(--faint)" }}>{n}</span>
      <span className="pj-metric-l">{label}</span>
    </div>
  );
}

export function ProjectCard({ p, repo, current, onOpen, onEdit }: {
  p: PortfolioProject; repo: string | null; current: boolean; onOpen: () => void; onEdit: () => void;
}): JSX.Element {
  const c = p.counts;
  const st = projectStatus(c);
  const tot = c.merged + c.working + c.needs + c.queued || 1;
  const segments = [
    { n: c.merged, color: "var(--st-merged)", label: "merged" },
    { n: c.working, color: "var(--st-working)", label: "working" },
    { n: c.needs, color: "var(--st-needs)", label: "needs you" },
    { n: c.queued, color: "var(--st-queued)", label: "up next" },
  ].filter((s) => s.n > 0).map((s) => ({ pct: (s.n / tot) * 100, color: s.color, label: s.label }));
  const hasBudget = p.budget !== null && p.budget > 0;
  const bpct = hasBudget ? Math.min(100, (p.spend / p.budget!) * 100) : 0;
  const bcolor = bpct >= 90 ? "var(--st-needs)" : bpct >= 70 ? "var(--st-review)" : "var(--st-merged)";

  return (
    <article className={`card pj-card${c.needs > 0 ? " attention" : ""}`} style={{ "--c": st.color } as CSSProperties}>
      <div className="pj-card-band">
        <span className="pj-card-icon" aria-hidden="true"><Layers size={20} /></span>
        <span className="row" style={{ gap: 6 }}>
          {current && <Tag>Current</Tag>}
          <Tag color={st.color} dot>{st.label}</Tag>
        </span>
      </div>
      <div className="pj-card-body">
        <div>
          <h3 className="pj-card-name">
            <button type="button" className="pj-card-open" onClick={onOpen} title={`Open ${p.name}`}>{p.name}</button>
          </h3>
          <div className="mono faint pj-card-repo" title={repo ?? p.workdir}>{baseName(repo ?? p.workdir)}</div>
        </div>
        <Bar segments={segments} height={7} />
        <div className="pj-metrics">
          <Metric n={c.working} label="working" color="var(--st-working)" />
          <Metric n={c.needs} label="attention" color="var(--st-needs)" />
          <Metric n={c.queued} label="up next" />
          <Metric n={c.merged} label="merged" />
        </div>
        {hasBudget && (
          <div className="pj-budget">
            <Bar segments={[{ pct: bpct, color: bcolor, label: "budget used" }]} height={5} />
            <span className="faint pj-budget-cap">{fmtUsd(p.spend)} / {fmtUsd(p.budget!)}</span>
          </div>
        )}
        <div className="row pj-card-foot">
          <span className="faint pj-updated">{p.updatedTs ? `Updated ${ago(p.updatedTs)}` : "No activity yet"}</span>
          <span className="spacer" />
          <span className="pj-card-actions">
            <IconBtn label={`Edit or remove ${p.name}`} small onClick={onEdit}><MoreHorizontal size={16} /></IconBtn>
            <Btn small onClick={onOpen}>Open</Btn>
          </span>
        </div>
      </div>
    </article>
  );
}
