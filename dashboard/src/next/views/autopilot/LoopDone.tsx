/** A finished autopilot loop: did it reach the objective, what it spent, and
 *  where its work is — the PR to review when one was opened, the integration
 *  branch to test otherwise. Then the way back to the form. */

import type { JSX } from "react";
import { Check, CircleDot, GitMerge } from "../../icons.js";
import { Btn, Card, Stat } from "../../ui.js";
import type { LoopState } from "./loop.js";

export function LoopDone({ loop, onNew }: { loop: LoopState; onNew: () => void }): JSX.Element {
  const ok = loop.stop === "success";
  return (
    <Card className="ap-done">
      <div className={`ap-done-badge${ok ? " ok" : ""}`} aria-hidden="true">
        {ok ? <Check size={24} /> : <CircleDot size={24} />}
      </div>
      <h2 className="ap-done-title">{ok ? "Objective reached" : `Stopped — ${loop.stop}`}</h2>
      {loop.objective && <p className="hint ap-done-obj">{loop.objective}</p>}
      <div className="ap-done-stats">
        <Stat value={`$${(loop.spent ?? 0).toFixed(2)}`} label={`spent of $${(loop.budget ?? 0).toFixed(2)}`} />
        <Stat value={loop.accepted ? "Yes" : "No"} label="objective met"
          color={loop.accepted ? "var(--st-merged)" : undefined} />
        {loop.iteration != null && <Stat value={loop.iteration} label={`round${loop.iteration === 1 ? "" : "s"} run`} />}
      </div>
      {loop.pr
        ? <a className="btn fill" href={loop.pr} target="_blank" rel="noreferrer"><GitMerge size={15} /> Review &amp; merge the PR</a>
        : <p className="hint">Work is on <span className="mono">{loop.integ}</span> — test it, then merge into {loop.base ?? "main"}.</p>}
      <Btn onClick={onNew}>Start a new loop</Btn>
    </Card>
  );
}
