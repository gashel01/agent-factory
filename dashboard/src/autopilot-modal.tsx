import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON, repoPath } from "./api.js";
import {
  Check, CircleDot, Flag, GitBranch, GitMerge, InfinityIcon, ListChecks, Lock, Play, Send, ShieldCheck, Sparkles,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";
import { AttachStrip, Button, toast, useAttachments, useManagedInterval } from "./core.js";
import { ConfirmButton, Modal } from "./widgets.js";

export interface LoopState {
  state: string; // idle | running | done | error
  name?: string; objective?: string; integ?: string; base?: string;
  budget?: number; maxIterations?: number; iteration?: number; spent?: number;
  stop?: string; accepted?: boolean; pr?: string;
}

/**
 * The opt-in autopilot loop: give it an objective + an executable acceptance
 * check, and it plans->runs on an integration branch (main untouched) under a
 * hard budget cap, opening a single PR at the end. Three states — create / live /
 * finished — driven by GET /api/loop. Never lets you start without a cap.
 */
export function AutopilotModal({ ws, onClose }: { ws: string; onClose: () => void }): JSX.Element {
  const [repo, setRepo] = useState("");
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [creating, setCreating] = useState(false); // force the create form after a finished loop
  const [mode, setMode] = useState("explicit"); // explicit | supervisor | self | backlog
  const [objective, setObjective] = useState("");
  const att = useAttachments();
  const [accept, setAccept] = useState("");
  const [budget, setBudget] = useState("10");
  const [maxIter, setMaxIter] = useState("5");
  const [drafting, setDrafting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [steerObj, setSteerObj] = useState("");   // live re-steer draft
  const [steering, setSteering] = useState(false);
  const steerDirty = useRef(false);
  const [costHint, setCostHint] = useState<number | null>(null);
  const every = useManagedInterval();

  const refresh = async (): Promise<LoopState | null> => {
    try {
      const l = await fetchJSON<LoopState>(`/api/loop?ws=${encodeURIComponent(ws)}`);
      setLoop(l);
      return l;
    } catch { return null; }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let r = repoPath();
      if (!r) {
        try {
          const list = await fetchJSON<{ workspaces?: Array<{ name: string; repo: string | null }> }>(
            "/api/workspaces",
          );
          r = (list.workspaces ?? []).find((w) => w.name === ws)?.repo ?? "";
        } catch { /* */ }
      }
      if (live) setRepo(r);
      await refresh();
      try {
        const f = await fetchJSON<{ history?: { medianUsdPerTicket?: number } }>(
          `/api/forecast?ws=${encodeURIComponent(ws)}`);
        if (live) setCostHint(f.history?.medianUsdPerTicket ?? null);
      } catch { /* the cost hint is optional */ }
    })();
    return () => { live = false; };
  }, [ws]);

  // Keep the re-steer draft in sync with the live objective until the operator edits it.
  useEffect(() => { if (!steerDirty.current) setSteerObj(loop?.objective ?? ""); }, [loop?.objective]);

  // Poll while a loop is live so the gauge and iteration keep up.
  useEffect(() => {
    every((stop) => { if (loop?.state !== "running") stop(); else void refresh(); }, 2500);
  }, [loop?.state]);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const r = await postJSON<{ ok?: boolean; objective?: string; accept?: string; error?: string }>(
        "/api/loop/draft", { repo });
      if (r.ok) { setObjective(r.objective ?? ""); setAccept(r.accept ?? ""); }
      else toast(r.error || "could not draft an objective", true);
    } catch (e) { toast(String(e), true); }
    finally { setDrafting(false); }
  };

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/loop/start", {
        mode, objective: objective + att.refs(), accept, repo,
        budget: Number(budget), maxIterations: Number(maxIter),
      });
      if (r.ok) { att.clear(); toast("Autopilot started."); setCreating(false); await refresh(); }
      else toast(r.error || "could not start the loop", true);
    } catch (e) { toast(String(e), true); }
    finally { setStarting(false); }
  };

  const stop = async (): Promise<void> => {
    try { await postJSON("/api/loop/stop", {}); toast("Autopilot stopped."); await refresh(); }
    catch (e) { toast(String(e), true); }
  };

  const steer = async (): Promise<void> => {
    setSteering(true);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/loop/steer",
        { objective: steerObj });
      if (r.ok) { toast("Re-steered — applies next round."); steerDirty.current = false; await refresh(); }
      else toast(r.error || "could not re-steer", true);
    } catch (e) { toast(String(e), true); }
    finally { setSteering(false); }
  };

  const running = loop?.state === "running";
  const finished = !running && !creating && !!loop?.stop;

  const MODES: Array<{ id: string; Icon: LucideIcon; title: string; desc: string }> = [
    { id: "explicit", Icon: Flag, title: "Objective", desc: "Pursue a goal until an acceptance check passes." },
    { id: "supervisor", Icon: Sparkles, title: "Mission", desc: "A supervisor turns a mission into a step each round." },
    { id: "self", Icon: InfinityIcon, title: "Auto-improve", desc: "Split the largest files until none stay oversized." },
    { id: "backlog", Icon: ListChecks, title: "Run backlog", desc: "Work through this project's backlog, hands-off." },
  ];
  const needObj = (mode === "explicit" || mode === "supervisor") && !objective.trim();
  const noCap = !(Number(budget) > 0);
  const capN = Number(budget) || 0;

  // Live spend ring (running state): the arc fills toward the cap, warming to
  // amber then red as it approaches.
  const spent = loop?.spent ?? 0;
  const cap = loop?.budget ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const R = 30;
  const CIRC = 2 * Math.PI * R;
  const ringColor = pct >= 95 ? "var(--st-failed-dot)" : pct >= 75 ? "var(--st-blocked-dot)" : "var(--accent)";

  return (
    <Modal title="Autopilot" onClose={onClose} wide>
      {running ? (
        <div className="loop-live">
          <div className="loop-live-top">
            <div className="loop-ring-wrap">
              <svg className="loop-ring" viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
                <circle className="loop-ring-track" cx="36" cy="36" r={R} />
                <circle className="loop-ring-arc" cx="36" cy="36" r={R}
                  style={{ stroke: ringColor, strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
              </svg>
              <div className="loop-ring-label">
                <span className="loop-ring-spent">${spent.toFixed(2)}</span>
                <span className="loop-ring-cap">of ${cap.toFixed(2)}</span>
              </div>
            </div>
            <div className="loop-live-head">
              <div className="loop-headline"><span className="loop-pulse" aria-hidden="true" /> Autopilot running</div>
              <div className="loop-substat">Iteration {loop?.iteration ?? "…"} · <span className="mono">{loop?.integ}</span></div>
              <div className="loop-safety">
                <span><GitBranch size={12} /> main untouched</span>
                <span><Lock size={12} /> capped at ${cap.toFixed(0)}</span>
              </div>
            </div>
          </div>

          {loop?.objective ? (
            <div className="loop-steer">
              <label className="work-label">Steer the objective — live</label>
              <textarea className="input" rows={3} value={steerObj}
                onChange={(e) => { steerDirty.current = true; setSteerObj(e.target.value); }} />
              <div className="loop-steer-row">
                <Button kind="btn" pending={steering}
                  disabled={steering || !steerObj.trim() || steerObj.trim() === (loop?.objective ?? "").trim()}
                  onClick={steer}><Send size={13} /> Re-steer</Button>
                <span className="loop-note">applied at the start of the next round — no restart</span>
              </div>
            </div>
          ) : (
            <p className="loop-note">Working autonomously — merges land on the integration branch; a PR opens when it finishes.</p>
          )}

          <ConfirmButton label="Stop autopilot" confirm="Stop now?" onConfirm={stop} />
        </div>
      ) : finished ? (
        <div className="loop-done">
          <div className={`loop-done-badge ${loop?.stop === "success" ? "ok" : "warn"}`}>
            {loop?.stop === "success" ? <Check size={22} /> : <CircleDot size={22} />}
          </div>
          <div className="loop-headline">
            {loop?.stop === "success" ? "Objective reached" : `Stopped — ${loop?.stop}`}
          </div>
          <div className="loop-done-stats">
            <div><span className="loop-stat-n">${(loop?.spent ?? 0).toFixed(2)}</span><span className="loop-stat-l">spent of ${(loop?.budget ?? 0).toFixed(2)}</span></div>
            <div><span className="loop-stat-n">{loop?.accepted ? "Yes" : "No"}</span><span className="loop-stat-l">objective met</span></div>
          </div>
          {loop?.pr
            ? <a className="btn primary loop-cta" href={loop.pr} target="_blank" rel="noreferrer"><GitMerge size={14} /> Review &amp; merge the PR</a>
            : <p className="loop-note">Work is on <span className="mono">{loop?.integ}</span> — test it, then merge into {loop?.base ?? "main"}.</p>}
          <Button kind="btn" onClick={() => { setCreating(true); setLoop({ state: "idle" }); }}>Start a new loop</Button>
        </div>
      ) : (
        <div className="loop-form">
          <div className="loop-cards" role="radiogroup" aria-label="Autopilot mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id}
                className={`loop-card${mode === m.id ? " on" : ""}`} onClick={() => setMode(m.id)}>
                <m.Icon size={18} />
                <span className="loop-card-title">{m.title}</span>
                <span className="loop-card-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          <div className="loop-fields">
            {(mode === "explicit" || mode === "supervisor") && (
              <>
                <label className="work-label">{mode === "supervisor" ? "Mission" : "Objective"}</label>
                <textarea className="input loop-obj-input" rows={4}
                  placeholder={mode === "supervisor"
                    ? "Describe the mission — the supervisor breaks it into a concrete step each round."
                    : `What should the autopilot achieve? Be specific about what "done" looks like.`}
                  value={objective} onChange={(e) => setObjective(e.target.value)}
                  onPaste={att.paste} onDrop={att.drop} onDragOver={(e) => e.preventDefault()} />
                <button type="button" className="loop-draft" disabled={!repo || drafting} onClick={() => void draft()}>
                  <Sparkles size={13} /> {drafting ? "Reading the repo…" : "Draft with AI"}
                </button>
                <AttachStrip items={att.items} onRemove={att.remove} />
              </>
            )}
            {mode === "explicit" && (
              <>
                <label className="work-label">Acceptance check <span className="loop-faint">— a command that exits 0 when done</span></label>
                <input className="input mono" placeholder="e.g. npm --prefix dashboard test"
                  value={accept} onChange={(e) => setAccept(e.target.value)} />
              </>
            )}
            {mode === "self" && (
              <p className="loop-mode-note"><InfinityIcon size={14} /> Each round splits the repo's largest file into modules, until none stay oversized. No objective needed.</p>
            )}
            {mode === "backlog" && (
              <p className="loop-mode-note"><ListChecks size={14} /> Works through this project's backlog on an integration branch — no planning spend.</p>
            )}
          </div>

          <div className="loop-safety loop-safety-strip">
            <span><GitBranch size={13} /> Isolated branch</span>
            <span><Lock size={13} /> Main untouched</span>
            <span><ShieldCheck size={13} /> Stops at ${capN || "—"}</span>
            <span><Check size={13} /> You review the PR</span>
          </div>

          <div className="loop-caps">
            <div>
              <label className="work-label">Budget cap ($)</label>
              <input className="input" type="number" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
              <span className="loop-faint">hard stop</span>
            </div>
            <div>
              <label className="work-label">Max iterations</label>
              <input className="input" type="number" min="1" value={maxIter} onChange={(e) => setMaxIter(e.target.value)} />
              <span className="loop-faint">rounds before it halts</span>
            </div>
          </div>
          {costHint != null && costHint > 0 && (
            <p className="loop-note">Your recent runs averaged <strong>~${costHint.toFixed(2)}/ticket</strong> — size the cap to how far you want it to go.</p>
          )}

          <div className="loop-launch">
            <Button kind="btn" variant="primary" className="loop-cta" pending={starting}
              disabled={needObj || noCap || !repo || starting} onClick={start}>
              <Play size={14} /> Start autopilot{capN ? ` · capped at $${capN}` : ""}
            </Button>
            {(needObj || noCap) && (
              <span className="loop-blocked">{noCap ? "Add a budget cap to start." : "Describe an objective to start."}</span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
