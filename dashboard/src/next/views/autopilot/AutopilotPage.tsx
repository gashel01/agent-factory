/** Autopilot: the opt-in loop that works toward a goal on its own integration
 *  branch under a hard budget cap, then opens one PR. Three states driven by
 *  GET /api/loop — the start form, the live loop, the finished result — like
 *  the classic modal, but as a page: the loop is a server process, so leaving
 *  and coming back finds it where it is. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { repoPath } from "../../../api.js";
import { toast, usePolling } from "../../../core.js";
import { useWarden } from "../../data.js";
import { Spinner, Tag } from "../../ui.js";
import { Topbar } from "../../shell/Topbar.js";
import { LoopDone } from "./LoopDone.js";
import { LoopForm } from "./LoopForm.js";
import { LoopLive } from "./LoopLive.js";
import { fetchCostHistory, fetchLoop, stopLoop } from "./loop.js";
import type { CostHistory, LoopState } from "./loop.js";

export function AutopilotPage(): JSX.Element {
  const w = useWarden();
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false); // the form, after a finished loop
  const [cost, setCost] = useState<CostHistory | null>(null);

  const refresh = async (): Promise<LoopState | null> => {
    try {
      const l = await fetchLoop(w.ws);
      setLoop(l); setFailed(false);
      return l;
    } catch { setFailed(true); return null; }
  };

  // The repo the loop works on: the one picked in the repo browser, else the
  // workspace's own (same order as the classic modal).
  const repo = repoPath() || (w.workspaces.find((x) => x.name === w.ws)?.repo ?? "");

  // The cost history that turns the budget into a ticket count — optional.
  useEffect(() => {
    let alive = true;
    setLoop(null); setCreating(false); setCost(null);
    fetchCostHistory(w.ws).then((c) => { if (alive) setCost(c); }).catch(() => { /* optional */ });
    return () => { alive = false; };
  }, [w.ws]);

  const running = loop?.state === "running";
  // Fast while a loop runs so the gauge keeps up; slow otherwise, so a loop
  // started from elsewhere (the CLI, another browser) still shows up here.
  usePolling(async (ctl) => {
    try {
      const l = await fetchLoop(w.ws);
      if (ctl.alive()) { setLoop(l); setFailed(false); }
    } catch { if (ctl.alive()) setFailed(true); }
  }, running ? 2500 : 15000, [w.ws, running]);

  const stop = async (): Promise<void> => {
    try { await stopLoop(); toast("Autopilot stopped."); await refresh(); }
    catch (e) { toast(String(e), true); }
  };

  const finished = !running && !creating && Boolean(loop?.stop);
  const status = running ? <Tag color="var(--st-working)" dot>Running</Tag>
    : finished ? <Tag color={loop?.stop === "success" ? "var(--st-merged)" : "var(--st-review)"} dot>Finished</Tag>
    : null;

  return (
    <>
      <Topbar title="Autopilot" sub="Works toward a goal on its own branch, under a budget">{status}</Topbar>
      <div className="view">
        {loop === null && failed ? (
          <p className="hint" role="alert">Couldn’t reach the server to read the autopilot’s state. It will retry on its own.</p>
        ) : loop === null ? (
          <div className="ap-loading"><Spinner /></div>
        ) : running ? (
          <LoopLive loop={loop} onChanged={refresh} onStop={stop} />
        ) : finished ? (
          <LoopDone loop={loop} onNew={() => { setCreating(true); setLoop({ state: "idle" }); }} />
        ) : (
          <LoopForm repo={repo} cost={cost} onStarted={async () => { setCreating(false); await refresh(); }} />
        )}
      </div>
    </>
  );
}
