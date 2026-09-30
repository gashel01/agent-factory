/** The tickets waiting in the backlog, reviewed before a run: pin a model or
 *  effort per ticket, skip tests or the AI reviewer, edit the raw file, delete
 *  it — then start the run (through the estimate, so the budget guard is seen).
 *  Per-ticket changes save immediately, like the classic TicketTune. */

import { useState } from "react";
import type { JSX } from "react";
import type { BoardTicket } from "../../../board-model.js";
import { fetchJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { EFFORT_CHOICES, MODEL_CHOICES } from "../../../model.js";
import { fmGet, fmSet } from "../../../tickets.js";
import { Pencil, Play, Trash2 } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Btn, IconBtn, Tag } from "../../ui.js";

function withCurrent(choices: Array<[string, string]>, value: string): Array<[string, string]> {
  return !value || choices.some(([v]) => v === value) ? choices : [...choices, [value, value]];
}

function Tune({ bt }: { bt: BoardTicket }): JSX.Element {
  const w = useWarden();
  const model = fmGet(bt.content, "model");
  const effort = fmGet(bt.content, "effort");
  const skipVerify = fmGet(bt.content, "skip_verify") === "true";
  const skipReview = fmGet(bt.content, "skip_review") === "true";
  const pin = (key: "model" | "effort", v: string): Promise<void> =>
    w.saveTicket(bt, fmSet(bt.content, key, v), v ? `Ticket pinned to ${key} “${v}”.` : `Ticket back to the default ${key}.`);
  const flag = (key: "skip_verify" | "skip_review", on: boolean): Promise<void> => {
    const what = key === "skip_verify" ? "verification" : "the AI reviewer";
    return w.saveTicket(bt, fmSet(bt.content, key, on ? "true" : ""),
      on ? `This ticket will skip ${what}.` : `This ticket is back to the default ${key === "skip_verify" ? "verification" : "review"}.`);
  };
  return (
    <div className="nw-draft-tune" title="Pinned for this ticket only — overrides the run-wide defaults from Settings.">
      <select className="input nw-mini" aria-label={`Model for ${bt.id}`} value={model} onChange={(e) => void pin("model", e.target.value)}>
        {withCurrent(MODEL_CHOICES, model).map(([v, l]) => <option key={v} value={v}>{v ? l.split(" — ")[0] : "Model: default"}</option>)}
      </select>
      <select className="input nw-mini" aria-label={`Effort for ${bt.id}`} value={effort} onChange={(e) => void pin("effort", e.target.value)}>
        {withCurrent(EFFORT_CHOICES, effort).map(([v, l]) => <option key={v} value={v}>{v ? l : "Effort: default"}</option>)}
      </select>
      <label className="nw-check"><input type="checkbox" checked={skipVerify} onChange={(e) => void flag("skip_verify", e.target.checked)} /> Skip tests</label>
      <label className="nw-check"><input type="checkbox" checked={skipReview} onChange={(e) => void flag("skip_review", e.target.checked)} /> Skip review</label>
    </div>
  );
}

function Draft({ bt }: { bt: BoardTicket }): JSX.Element {
  const w = useWarden();
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(bt.content);
  const [armed, setArmed] = useState(false);

  const remove = async (): Promise<void> => {
    if (!armed) { setArmed(true); window.setTimeout(() => setArmed(false), 4000); return; }
    try {
      await fetchJSON(`/api/backlog/${encodeURIComponent(bt.file)}`, { method: "DELETE" });
      toast("Ticket deleted.");
      w.refreshBacklog();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <li className="card tight nw-draft">
      <div className="row nw-draft-head">
        <span className="mono faint">{bt.id}</span>
        <b className="nw-draft-title">{bt.title}</b>
        {bt.assignee === "human" && <Tag>Yours</Tag>}
        {bt.hold && <Tag color="var(--st-review)">On hold</Tag>}
        <span className="spacer" />
        <IconBtn small label={`Edit ${bt.id}`} on={editing} onClick={() => { setRaw(bt.content); setEditing(!editing); }}><Pencil size={15} /></IconBtn>
        <Btn small kind={armed ? "danger" : "ghost"} onClick={remove}>
          <Trash2 size={14} />{armed ? " Sure? Click again" : <span className="sr-only">Delete {bt.id}</span>}
        </Btn>
      </div>
      {editing ? (
        <div className="stack nw-draft-edit">
          <textarea className="input mono nw-raw" aria-label={`Ticket file ${bt.file}`} value={raw} onChange={(e) => setRaw(e.target.value)} />
          <div className="row">
            <span className="faint mono">{bt.file}</span>
            <span className="spacer" />
            <Btn small kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
            <Btn small kind="fill" onClick={async () => { await w.saveTicket(bt, raw, "Ticket saved."); setEditing(false); }}>Save</Btn>
          </div>
        </div>
      ) : <Tune bt={bt} />}
    </li>
  );
}

export function DraftsReview(): JSX.Element | null {
  const w = useWarden();
  const drafts = w.boardTickets.filter((bt) => !w.hiddenIds.has(bt.id));
  if (drafts.length === 0) return null;
  return (
    <section className="stack nw-drafts" aria-label="Tickets ready">
      <div className="row">
        <h3 className="card-title">Tickets ready ({drafts.length})</h3>
        <span className="spacer" />
        <Btn small kind="fill" disabled={w.live || w.willRun === 0}
          title={w.live ? "A run is already in progress" : w.willRun === 0 ? "Nothing to run — every ticket is on hold or yours" : undefined}
          onClick={() => w.open({ type: "runestimate", tickets: w.willRun })}>
          <Play size={14} /> Start run{w.willRun ? ` (${w.willRun})` : ""}
        </Btn>
      </div>
      <ul className="stack nw-draft-list">{drafts.map((bt) => <Draft key={bt.file} bt={bt} />)}</ul>
    </section>
  );
}
