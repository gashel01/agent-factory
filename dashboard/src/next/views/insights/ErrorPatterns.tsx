/** Why tickets failed, across the runs in view: each failure category the
 *  server's diagnosis found, as a horizontal bar sized against the most common
 *  one, then the most common cause and what to do about it. */

import type { JSX } from "react";
import { Card } from "../../ui.js";
import { recommendation } from "./analytics.js";
import type { Pattern } from "./analytics.js";

export function ErrorPatterns({ patterns, total, top, runCount }: {
  patterns: Pattern[]; total: number; top: Pattern | null; runCount: number;
}): JSX.Element {
  const max = Math.max(1, ...patterns.map((p) => p.count));
  return (
    <Card>
      <div className="row in-chart-head">
        <h2 className="card-title">Why tickets failed</h2>
        <span className="faint">{total} failure{total === 1 ? "" : "s"}</span>
      </div>
      <ul className="in-patterns">
        {patterns.map((p) => (
          <li key={p.category} className="in-pattern">
            <span className="in-pattern-name">{p.label}</span>
            <span className="in-pattern-track" aria-hidden="true">
              <span className="in-pattern-fill" style={{ width: `${(p.count / max) * 100}%` }} />
            </span>
            <span className="in-pattern-n">
              {p.count}<span className="sr-only"> ({Math.round((p.count / total) * 100)}% of failures)</span>
            </span>
          </li>
        ))}
      </ul>
      {top && (
        <div className="in-advice">
          <p><b>Most common cause:</b> {top.label.toLowerCase()} — the top cause in {top.runs} of {runCount} run{runCount === 1 ? "" : "s"} ({Math.round((top.runs / Math.max(1, runCount)) * 100)}%).</p>
          <p className="hint">{recommendation(top.category)}</p>
        </div>
      )}
      <p className="hint">Counted from the diagnosis of every ticket in these runs. Tickets that shipped, or whose end
        has no clear cause, aren’t counted.</p>
    </Card>
  );
}
