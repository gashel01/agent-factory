/** One thing the supervisor proposes, as a chip the operator clicks. The
 *  supervisor can't write run commands itself any more — every retry / stop /
 *  pause it suggests only happens through one of these clicks, and "plan" opens
 *  the goal planner pre-filled rather than drafting tickets on its own. */

import { useState } from "react";
import type { JSX } from "react";
import type { ObsAction } from "../../../companion.js";
import { sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { Play, Sparkles } from "../../icons.js";

const OP_HINT: Record<ObsAction["op"], string> = {
  retry: "Put this ticket back in the queue with a fresh budget",
  kill: "Cancel this ticket — it won't merge",
  pause: "Pause the run — running agents finish, no new ones start",
  resume: "Resume the run",
  stop: "Stop the run — running agents finish, the rest stays queued",
  plan: "Open the planner with this goal filled in — nothing is drafted until you say so",
};

export function Suggestion({ s }: { s: ObsAction }): JSX.Element {
  const w = useWarden();
  const [busy, setBusy] = useState(false);
  const click = (): void => {
    if (s.op === "plan") { w.open({ type: "newwork", tab: "goal", goal: s.goal ?? "" }); return; }
    setBusy(true);
    void sendControl(s.op, s.task).finally(() => setBusy(false));
  };
  const Icon = s.op === "plan" ? Sparkles : Play;
  return (
    <button type="button" className="sv-chip" onClick={click} disabled={busy} aria-busy={busy || undefined}
      title={`${OP_HINT[s.op]}${s.task ? ` (${s.task})` : ""}`}>
      {busy ? <span className="spinner" aria-hidden="true" /> : <Icon size={13} aria-hidden />}
      {s.label}
    </button>
  );
}
