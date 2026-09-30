/** The "start an autopilot" form: pick a mode, write (or AI-draft) the
 *  objective and its acceptance check, set the hard budget cap and the round
 *  backstop. Mirrors the classic modal's create state field for field — and,
 *  like it, never lets a loop start without a cap, an objective when the mode
 *  needs one, or a repo to work on. */

import { useState } from "react";
import type { JSX } from "react";
import { Check, GitBranch, Lock, Play, ShieldCheck, Sparkles, X } from "../../icons.js";
import { toast, useAttachments } from "../../../core.js";
import { Btn, Card } from "../../ui.js";
import { MODES, draftObjective, needsObjective, startLoop } from "./loop.js";
import type { CostHistory, LoopMode } from "./loop.js";

export function LoopForm({ repo, cost, onStarted }: {
  repo: string; cost: CostHistory | null; onStarted: () => Promise<unknown>;
}): JSX.Element {
  const [mode, setMode] = useState<LoopMode>("explicit");
  const [objective, setObjective] = useState("");
  const [accept, setAccept] = useState("");
  const [budget, setBudget] = useState("10");
  const [maxIter, setMaxIter] = useState("5");
  const [drafting, setDrafting] = useState(false);
  const att = useAttachments();

  const capN = Number(budget) || 0;
  const needObj = needsObjective(mode) && !objective.trim();
  const noCap = !(Number(budget) > 0);
  const blocker = !repo ? "This project has no repository linked yet, so there is nothing to work on."
    : noCap ? "Add a budget cap to start."
    : needObj ? "Describe an objective to start." : "";

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const r = await draftObjective(repo);
      if (r.ok) { setObjective(r.objective ?? ""); setAccept(r.accept ?? ""); }
      else toast(r.error || "could not draft an objective", true);
    } catch (e) { toast(String(e), true); }
    finally { setDrafting(false); }
  };

  const start = async (): Promise<void> => {
    try {
      const r = await startLoop({
        mode, objective: objective + att.refs(), accept, repo,
        budget: Number(budget), maxIterations: Number(maxIter),
      });
      if (r.ok) { att.clear(); toast("Autopilot started."); await onStarted(); }
      else toast(r.error || "could not start the loop", true);
    } catch (e) { toast(String(e), true); }
  };

  return (
    <div className="ap-layout">
      <section className="stack ap-main">
        <div className="ap-modes" role="radiogroup" aria-label="Autopilot mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id}
              className="ap-mode" onClick={() => setMode(m.id)}>
              <m.Icon size={18} aria-hidden="true" />
              <span className="ap-mode-title">{m.title}</span>
              <span className="ap-mode-desc">{m.desc}</span>
            </button>
          ))}
        </div>

        {needsObjective(mode) && (
          <div className="field">
            <label className="field-label" htmlFor="ap-goal">{mode === "supervisor" ? "Mission" : "Objective"}</label>
            <textarea id="ap-goal" className="input ap-goal" rows={6}
              placeholder={mode === "supervisor"
                ? "Describe the mission — the supervisor breaks it into a concrete step each round."
                : "What should the autopilot achieve? Be specific about what “done” looks like."}
              value={objective} onChange={(e) => setObjective(e.target.value)}
              onPaste={att.paste} onDrop={att.drop} onDragOver={(e) => e.preventDefault()} />
            <p className="hint">You can paste or drop screenshots here — the agent gets to see them.</p>
            {att.items.length > 0 && (
              <div className="ap-attach">
                {att.items.map((a) => (
                  <div key={a.path} className="ap-thumb" title={a.name}>
                    <img src={a.thumb} alt={a.name} />
                    <button type="button" className="ap-thumb-x" aria-label={`Remove ${a.name}`} onClick={() => att.remove(a.path)}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <Btn small kind="ghost" onClick={draft} disabled={!repo || drafting} busy={drafting}>
                <Sparkles size={14} /> {drafting ? "Reading the repo…" : "Draft with AI"}
              </Btn>
            </div>
          </div>
        )}

        {mode === "explicit" && (
          <div className="field">
            <label className="field-label" htmlFor="ap-check">Done when this passes</label>
            <input id="ap-check" className="input mono" placeholder="e.g. npm --prefix dashboard test"
              value={accept} onChange={(e) => setAccept(e.target.value)} />
            <p className="hint">A command that has to pass. Leave it empty to just run until the budget cap.</p>
          </div>
        )}
        {mode === "self" && (
          <Card tight><p className="hint">Each round splits the repo’s largest file into modules, until none stay oversized. No objective needed.</p></Card>
        )}
        {mode === "backlog" && (
          <Card tight><p className="hint">Works through this project’s backlog on an integration branch — no planning spend.</p></Card>
        )}
      </section>

      <aside className="stack ap-side">
        <Card>
          <label className="label" htmlFor="ap-budget">Spend up to</label>
          <div className="ap-money">
            <span className="ap-money-sign" aria-hidden="true">$</span>
            <input id="ap-budget" className="ap-money-input" type="number" min="1" value={budget}
              onChange={(e) => setBudget(e.target.value)} aria-label="Budget cap in dollars" />
          </div>
          <p className="hint">
            {cost && capN > 0
              ? `≈ ${Math.max(1, Math.round(capN / cost.medianUsdPerTicket))} tickets at your recent ~$${cost.medianUsdPerTicket.toFixed(2)} each${cost.runs ? ` (from ${cost.runs} past run${cost.runs === 1 ? "" : "s"})` : ""}.`
              : "A hard stop — the loop never spends past this."}
          </p>
          <div className="divider" />
          <div className="ap-backstop">
            <label htmlFor="ap-rounds" className="dim">Safety backstop — stop after</label>
            <input id="ap-rounds" className="input ap-rounds" type="number" min="1" value={maxIter}
              onChange={(e) => setMaxIter(e.target.value)} />
            <span className="dim">rounds at most, even under budget</span>
          </div>
        </Card>

        <Card>
          <span className="label">Guarantees</span>
          <ul className="ap-guarantees">
            <li><GitBranch size={15} aria-hidden="true" /> Works on an isolated branch</li>
            <li><Lock size={15} aria-hidden="true" /> Main is never touched</li>
            <li><ShieldCheck size={15} aria-hidden="true" /> Stops at {capN ? `$${capN}` : "the cap"}</li>
            <li><Check size={15} aria-hidden="true" /> You review one PR at the end</li>
          </ul>
        </Card>

        <Btn kind="fill" block onClick={start} disabled={Boolean(blocker)}>
          <Play size={15} /> Start autopilot{capN ? ` · capped at $${capN}` : ""}
        </Btn>
        {blocker && <p className="hint ap-blocker" role="status">{blocker}</p>}
        <p className="hint">It keeps running if you leave this page — come back here to watch or stop it.</p>
      </aside>
    </div>
  );
}
