/** A per-run bar chart in plain divs: one column per run, oldest on the left,
 *  optionally stacked (tickets shipped vs. needing you). The scale's top and
 *  the first/latest run are labelled; hovering a bar reads its value out in the
 *  header. Screen readers get a one-line summary plus the full numbers as a
 *  visually hidden table — the bars themselves are decoration to them. */

import { useState } from "react";
import type { CSSProperties, JSX } from "react";

export interface BarSeg { name: string; value: number; color: string }
export interface BarDatum { label: string; segs: BarSeg[] }

export function RunBars({ title, data, fmt, peakWord, summary }: {
  title: string; data: BarDatum[]; fmt: (n: number) => string;
  /** How the tallest bar is described ("most expensive", "busiest"). */
  peakWord: string;
  /** One sentence for screen readers. */
  summary: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const sum = (d: BarDatum): number => d.segs.reduce((a, s) => a + s.value, 0);
  const max = Math.max(0, ...data.map(sum));
  const shown = hover !== null ? data[hover] : undefined;
  const legend = data[0]?.segs.length && data[0].segs.length > 1 ? data[0].segs : null;

  return (
    <section className="card in-chart" aria-label={title}>
      <div className="row in-chart-head">
        <h2 className="card-title">{title}</h2>
        <span className="faint mono in-chart-read" aria-hidden="true">
          {shown ? `${shown.label} · ${shown.segs.map((s) => (legend ? `${fmt(s.value)} ${s.name}` : fmt(s.value))).join(" · ")}`
            : max > 0 ? `${peakWord}: ${fmt(max)}` : ""}
        </span>
      </div>
      <div className="in-plot">
        <div className="in-axis" aria-hidden="true">
          <span>{fmt(max)}</span>
          <span>{fmt(0)}</span>
        </div>
        <div className="in-bars" role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => {
            const total = sum(d);
            return (
              <div key={i} className={`in-col${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)}>
                <div className="in-stack" style={{ height: max > 0 ? `${(total / max) * 100}%` : "0%" }}>
                  {d.segs.filter((s) => s.value > 0).map((s) => (
                    <span key={s.name} className="in-seg"
                      style={{ "--c": s.color, flexGrow: s.value } as CSSProperties} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="row faint in-chart-foot" aria-hidden="true">
        <span>{data[0]?.label ?? ""}</span>
        {legend && (
          <span className="in-legend">
            {legend.map((s) => <span key={s.name} className="in-key" style={{ "--c": s.color } as CSSProperties}>{s.name}</span>)}
          </span>
        )}
        <span>{data.length > 1 ? data[data.length - 1]!.label : ""}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Run</th>{(data[0]?.segs ?? []).map((s) => <th key={s.name} scope="col">{s.name}</th>)}</tr></thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}><th scope="row">{d.label}</th>{d.segs.map((s) => <td key={s.name}>{fmt(s.value)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
