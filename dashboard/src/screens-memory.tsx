import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON } from "./api.js";
import { ago } from "./model.js";
import type { TaskModel } from "./model.js";
import { CornerDownLeft } from "./icons.js";
import { Modal, ConfirmButton, Select } from "./widgets.js";
import { toast, Skeleton } from "./core.js";
import type { Appearance } from "./screens-theme.js";
import { AppBar, PageHead, AppearanceModal } from "./screens.js";
import type { HeaderMenu } from "./screens.js";

export interface Fact { id: string; text: string; scope: "project" | "global"; ticketId: string | null; createdTs: string; applied?: number }

export function FactEditor(
  { fact, tasks, draft, onClose, onSaved }:
  { fact: Fact | "new"; tasks: TaskModel[]; draft?: { text: string; ticketId: string };
    onClose: () => void; onSaved: () => void },
): JSX.Element {
  const isNew = fact === "new";
  const f = isNew ? null : fact;
  const [text, setText] = useState(f?.text ?? draft?.text ?? "");
  const [scope, setScope] = useState<"project" | "global">(f?.scope ?? "project");
  const [ticketId, setTicketId] = useState(f?.ticketId ?? draft?.ticketId ?? "");

  const save = async (): Promise<void> => {
    if (!text.trim()) { toast("Write the lesson first.", true); return; }
    const body = { text: text.trim(), scope, ticketId: ticketId || null };
    try {
      if (isNew) await postJSON("/api/memory", body);
      else await fetchJSON(`/api/memory/${encodeURIComponent(f!.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      toast("Lesson saved."); onSaved(); onClose();
    } catch (err) { toast(String(err), true); }
  };
  const remove = async (): Promise<void> => {
    try { await fetchJSON(`/api/memory/${encodeURIComponent(f!.id)}`, { method: "DELETE" }); toast("Lesson deleted."); onSaved(); onClose(); }
    catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title={isNew ? "Add a lesson" : "Edit lesson"} onClose={onClose}>
      <div className="work-form">
        <label className="work-label">The lesson / rule learned</label>
        <textarea className="input fact-text-input" value={text} placeholder="e.g. always check test data matches the mockup before review…"
          onChange={(e) => setText(e.target.value)} />
        <div className="field-row">
          <div className="field">
            <label className="work-label">Scope</label>
            <Select className="wide" value={scope} onChange={(v) => setScope(v as "project" | "global")} ariaLabel="Scope"
              options={[{ value: "project", label: "This project only" }, { value: "global", label: "All projects (global)" }]} />
          </div>
          <div className="field">
            <label className="work-label">Origin ticket</label>
            <Select className="wide" value={ticketId} onChange={setTicketId} ariaLabel="Origin ticket"
              options={[{ value: "", label: "— None (manual) —" }, ...tasks.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))]} />
          </div>
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        {!isNew ? <ConfirmButton label="Delete" confirm="Sure? Click again" onConfirm={() => void remove()} /> : <span />}
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

export function FactCard({ f, onEdit }: { f: Fact; onEdit: () => void }): JSX.Element {
  return (
    <div className="fact-card">
      <div className="fact-text">{f.text}</div>
      <div className="fact-foot">
        <span className={`pill fam-${f.scope === "global" ? "working" : "upnext"}`}>
          {f.scope === "global" ? "Global" : "This project"}
        </span>
        {f.ticketId && <span className="fact-ticket mono"><CornerDownLeft size={12} /> {f.ticketId}</span>}
        {f.applied ? <span className="fact-used" title="How often this lesson was fed to an agent">used {f.applied}×</span> : null}
        <span className="fact-when">{ago(f.createdTs)}</span>
        <button className="btn link fact-edit" onClick={onEdit}>edit</button>
      </div>
    </div>
  );
}

export function useFacts(ws: string): { facts: Fact[] | null; reload: () => void } {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ facts: Fact[] }>("/api/memory"); setFacts(r.facts); }
    catch { /* keep the previous facts */ }
  }, []);
  useEffect(() => { setFacts(null); void reload(); }, [ws, reload]);
  return { facts, reload: () => void reload() };
}

export function MemoryScreen(
  { ws, tasks, theme, onProjects, menu }:
  { ws: string; tasks: TaskModel[]; theme: Appearance; onProjects: () => void; menu: HeaderMenu },
): JSX.Element {
  const { facts, reload } = useFacts(ws);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [editing, setEditing] = useState<Fact | "new" | null>(null);
  const [showAppearance, setShowAppearance] = useState(false);

  const all = facts ?? [];
  const filtered = all.filter((f) => {
    if (scope !== "all" && f.scope !== scope) return false;
    if (q && !(f.text.toLowerCase().includes(q.toLowerCase()) || (f.ticketId ?? "").toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const globalCount = all.filter((f) => f.scope === "global").length;
  const usedTotal = all.reduce((s, f) => s + (f.applied ?? 0), 0);
  const synth = `${all.length} lesson${all.length === 1 ? "" : "s"} learned · ${globalCount} global`
    + (usedTotal > 0 ? ` · applied ${usedTotal}×` : "");
  const scopes: Array<["all" | "global" | "project", string]> = [["all", "All"], ["global", "Global"], ["project", "This project"]];

  return (
    <>
      <AppBar active="memory" factCount={all.length} narrow newLabel="New lesson" theme={theme}
        onProjects={onProjects} onMemory={() => {}} onNew={() => setEditing("new")}
        onAppearance={() => setShowAppearance(true)} menu={menu} />
      <div className="page narrow">
        <PageHead title="Memory" synthFam="merged" synth={synth}
          lead="Each lesson is learned from a task and applied to the next ones — so the same mistake isn't made twice." />

        <div className="mem-toolbar">
          <input className="input" placeholder="Search a lesson or a ticket…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="nav-pills">
            {scopes.map(([v, label]) => (
              <button key={v} className={`nav-pill${scope === v ? " on" : ""}`} onClick={() => setScope(v)}>{label}</button>
            ))}
          </div>
        </div>

        {facts === null ? (
          <div className="empty-state" style={{ alignSelf: "stretch" }}><Skeleton lines={4} /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {all.length === 0
              ? "No lessons yet. When an agent hits a wall, record the fix here so it never happens twice."
              : "No lessons match this filter."}
          </div>
        ) : (
          <div className="fact-list">
            {filtered.map((f) => <FactCard key={f.id} f={f} onEdit={() => setEditing(f)} />)}
          </div>
        )}

        {editing && <FactEditor fact={editing} tasks={tasks} onClose={() => setEditing(null)} onSaved={reload} />}
      </div>
      {showAppearance && <AppearanceModal theme={theme} onClose={() => setShowAppearance(false)} />}
    </>
  );
}
