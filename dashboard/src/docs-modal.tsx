import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON } from "./api.js";
import { X } from "./icons.js";
import { Skeleton, toast } from "./core.js";
import { Drawer } from "./widgets.js";

export interface KnowledgeDoc {
  id: string; name: string; size: number; addedTs: string; chunks: number | null; error?: string;
}

export function DocsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await fetchJSON<{ enabled: boolean; docs: KnowledgeDoc[] }>("/api/knowledge");
    setEnabled(r.enabled); setDocs(r.docs);
  };
  useEffect(() => { void load(); }, []);

  const toggle = async (on: boolean): Promise<void> => {
    setEnabled(on); // optimistic
    try { await postJSON("/api/knowledge/enable", { enabled: on }); }
    catch (err) { setEnabled(!on); toast(String(err), true); }
  };
  const add = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) { toast("Give the note a name and some content.", true); return; }
    setBusy(true);
    try {
      const r = await postJSON<{ ok: boolean; doc: KnowledgeDoc; error?: string }>("/api/knowledge", { name, content });
      if (!r.ok) throw new Error(r.doc?.error || r.error || "ingest failed");
      setName(""); setContent(""); await load();
      toast(`Added "${r.doc.name}" (${r.doc.chunks ?? 0} chunks). Agents can now search it.`);
    } catch (err) { toast(String(err), true); }
    finally { setBusy(false); }
  };
  const remove = async (d: KnowledgeDoc): Promise<void> => {
    setDocs((cur) => cur?.filter((x) => x.id !== d.id) ?? cur); // optimistic
    try { await fetchJSON(`/api/knowledge/${encodeURIComponent(d.id)}`, { method: "DELETE" }); await load(); }
    catch (err) { toast(String(err), true); void load(); }
  };
  const pickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setContent(String(reader.result ?? "")); if (!name.trim()) setName(f.name); };
    reader.readAsText(f); // text/markdown notes; binary formats (PDF) aren't supported yet
  };

  return (
    <Drawer title="Knowledge base" onClose={onClose} foot={
      <button className="btn primary" disabled={busy || !name.trim() || !content.trim()} onClick={() => void add()}>
        {busy ? "Ingesting…" : "Add to knowledge"}
      </button>
    }>
      <div className="panel-body docs-form">
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Give agents your docs</div>
            <div className="setting-hint">
              Company knowledge that isn't in the code — business rules, domain notes, a Confluence export.
              Agents search it (locally, offline) while they work, so they honour the "why", not just the code.
            </div>
          </div>
          <input type="checkbox" className="switch" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        </div>
        {!enabled && <div className="docs-note">Turn this on to wire the knowledge base into your agents' next run.</div>}

        <label className="docs-label">Name</label>
        <input className="input" value={name} placeholder="tva-belgique.md" onChange={(e) => setName(e.target.value)} />
        <label className="docs-label">Content
          <span className="docs-file"><input type="file" accept=".md,.txt,.csv,.json,text/*" onChange={pickFile} /> or pick a text file</span>
        </label>
        <textarea className="input docs-text" rows={7} value={content}
          placeholder="Paste a business rule, a domain note, a runbook…"
          onChange={(e) => setContent(e.target.value)} />

        <div className="docs-list">
          {docs === null && <Skeleton lines={3} />}
          {docs?.length === 0 && <div className="docs-empty">No documents yet. Add your first note above.</div>}
          {docs?.map((d) => (
            <div key={d.id} className="docs-item">
              <div className="docs-item-main">
                <div className="docs-item-name">{d.name}</div>
                <div className="docs-item-meta">
                  {d.error ? <span className="docs-err">ingest failed</span>
                    : <span>{d.chunks ?? 0} chunk{d.chunks === 1 ? "" : "s"}</span>}
                  <span> · {Math.max(1, Math.round(d.size / 1024))} KB</span>
                </div>
              </div>
              <button className="btn icon" aria-label={`Remove ${d.name}`} onClick={() => void remove(d)}><X size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
