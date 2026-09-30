/** A running autopilot loop: the spend gauge against its cap, the round it is
 *  on, its integration branch, the live re-steer box and the stop button. The
 *  page polls GET /api/loop while this shows, so every number here is the
 *  server's, a couple of seconds old at most. */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { GitBranch, Lock, Send, Square } from "../../icons.js";
import { toast } from "../../../core.js";
import { Btn, Card } from "../../ui.js";
import { gaugeColor, steerLoop } from "./loop.js";
import type { LoopState } from "./loop.js";

const R = 52;
const CIRC = 2 * Math.PI * R;

export function LoopLive({ loop, onChanged, onStop }: {
  loop: LoopState; onChanged: () => Promise<unknown>; onStop: () => Promise<unknown>;
}): JSX.Element {
  const spent = loop.spent ?? 0;
  const cap = loop.budget ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const color = gaugeColor(pct);

  return (
    <div className="ap-layout">
      <section className="stack ap-main">
        <Card>
          <div className="ap-live">
            <div className="ap-ring" role="img" aria-label={`Spent $${spent.toFixed(2)} of a $${cap.toFixed(2)} cap (${Math.round(pct)}%)`}>
              <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
                <circle className="ap-ring-track" cx="60" cy="60" r={R} />
                <circle className="ap-ring-arc" cx="60" cy="60" r={R}
                  style={{ stroke: color, strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
              </svg>
              <div className="ap-ring-label" aria-hidden="true">
                <span className="ap-ring-spent">${spent.toFixed(2)}</span>
                <span className="faint">of ${cap.toFixed(2)}</span>
              </div>
            </div>
            <div className="stack ap-live-head">
              <p className="ap-live-title"><span className="ap-pulse" aria-hidden="true" /> Autopilot running</p>
              <p className="dim">
                Round {loop.iteration ?? "…"}{loop.maxIterations ? ` of ${loop.maxIterations} at most` : ""}
                {loop.integ && <> · <span className="mono">{loop.integ}</span></>}
              </p>
              <div className="ap-chips">
                <span className="ap-chip"><GitBranch size={13} aria-hidden="true" /> main untouched</span>
                <span className="ap-chip"><Lock size={13} aria-hidden="true" /> capped at ${cap.toFixed(0)}</span>
              </div>
            </div>
          </div>
        </Card>

        {loop.objective
          ? <SteerBox objective={loop.objective} onChanged={onChanged} />
          : <p className="hint">Working autonomously — merges land on the integration branch; a PR opens when it finishes.</p>}
      </section>

      <aside className="stack ap-side">
        <Card>
          <span className="label">Stop</span>
          <p className="hint">Stopping kills the loop now. What it already merged stays on its integration branch.</p>
          <StopButton onStop={onStop} />
        </Card>
        <p className="hint">It keeps running if you leave this page.</p>
      </aside>
    </div>
  );
}

/** Rewrite the running loop's objective; the loop re-reads it at the top of its
 *  next round, no restart. The draft follows the live objective until edited. */
function SteerBox({ objective, onChanged }: { objective: string; onChanged: () => Promise<unknown> }): JSX.Element {
  const [draft, setDraft] = useState(objective);
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(objective); }, [objective]);

  const steer = async (): Promise<void> => {
    try {
      const r = await steerLoop(draft);
      if (r.ok) { toast("Re-steered — applies next round."); dirty.current = false; await onChanged(); }
      else toast(r.error || "could not re-steer", true);
    } catch (e) { toast(String(e), true); }
  };

  const unchanged = !draft.trim() || draft.trim() === objective.trim();
  return (
    <div className="field">
      <label className="field-label" htmlFor="ap-steer">Steer the objective — live</label>
      <textarea id="ap-steer" className="input" rows={4} value={draft}
        onChange={(e) => { dirty.current = true; setDraft(e.target.value); }} />
      <div className="row">
        <Btn small onClick={steer} disabled={unchanged}><Send size={14} /> Re-steer</Btn>
        <span className="hint">Applied at the start of the next round — no restart.</span>
      </div>
    </div>
  );
}

/** Two-step stop, like the classic confirm button: the first click arms it. */
function StopButton({ onStop }: { onStop: () => Promise<unknown> }): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed
    ? <Btn kind="danger" block onClick={onStop}><Square size={14} /> Stop now?</Btn>
    : <Btn block onClick={() => setArmed(true)}><Square size={14} /> Stop autopilot</Btn>;
}
