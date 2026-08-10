import type { JSX, ReactNode } from "react";

export function PageHead(
  { title, synthFam, synth, lead, stats }:
  { title: string; synthFam: string; synth: string; lead?: string; stats?: ReactNode },
): JSX.Element {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <div className="page-synth">
          <span className="halo" aria-hidden="true" style={{ background: `var(--st-${synthFam}-dot)`, boxShadow: `0 0 0 4px var(--st-${synthFam}-bg)` }} />
          <b>{synth}</b>
        </div>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {stats && <div className="stat-tiles">{stats}</div>}
    </div>
  );
}

export function StatTile({ value, label, color }: { value: ReactNode; label: string; color?: string }): JSX.Element {
  return (
    <div className="stat-tile">
      <span className="st-v" style={color ? { color } : undefined}>{value}</span>
      <span className="st-l">{label}</span>
    </div>
  );
}

export function SegBar({ segs }: { segs: Array<{ pct: number; color: string }> }): JSX.Element {
  return (
    <div className="seg-bar">
      {segs.map((s, i) => <div key={i} style={{ width: `${s.pct}%`, background: s.color }} />)}
    </div>
  );
}
