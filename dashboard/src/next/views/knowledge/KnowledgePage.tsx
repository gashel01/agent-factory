/** Knowledge: company docs the agents search (locally, offline, via ragmcp)
 *  while they work — business rules, domain notes, a Confluence export. The
 *  switch wires the knowledge base into the agents' next run (it adds or drops
 *  `agent.mcp_config` in factory.yaml server-side); the form ingests a note or
 *  a text file; the list shows what's in and removes a doc. Same endpoints and
 *  edge cases as the classic Docs drawer (src/docs-modal.tsx). */

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, JSX } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import type { KnowledgeDoc } from "../../../api-shapes.js";
import { FileText } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Switch } from "../../ui.js";
import { DocList } from "./DocList.js";

export function KnowledgePage(): JSX.Element {
  const { ws } = useWarden();
  const [enabled, setEnabled] = useState(false);
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    try {
      const r = await fetchJSON<{ enabled: boolean; docs: KnowledgeDoc[] }>("/api/knowledge");
      setEnabled(r.enabled); setDocs(r.docs); setLoadError(false);
    } catch { setLoadError(true); setDocs((d) => d ?? []); }
  };
  useEffect(() => { setDocs(null); void load(); }, [ws]);

  const toggle = async (on: boolean): Promise<void> => {
    setEnabled(on); // optimistic
    try {
      await postJSON("/api/knowledge/enable", { enabled: on });
      toast(on ? "Knowledge base on — agents search it from their next run." : "Knowledge base off for the next run.");
    } catch (err) { setEnabled(!on); toast(String(err), true); }
  };

  const add = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) { toast("Give the note a name and some content.", true); return; }
    setBusy(true);
    try {
      const r = await postJSON<{ ok: boolean; doc: KnowledgeDoc; error?: string }>("/api/knowledge", { name, content });
      // An ingest failure still answers 200 — the doc is listed with its error.
      if (!r.ok) { await load(); throw new Error(r.doc?.error ? "the document was saved but couldn't be indexed" : r.error || "ingest failed"); }
      setName(""); setContent(""); await load();
      toast(`Added "${r.doc.name}" (${r.doc.chunks ?? 0} chunks). Agents can now search it.`);
    } catch (err) { toast(String(err), true); }
    finally { setBusy(false); }
  };

  const remove = async (d: KnowledgeDoc): Promise<void> => {
    setDocs((cur) => cur?.filter((x) => x.id !== d.id) ?? cur); // optimistic
    try {
      await fetchJSON(`/api/knowledge/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      toast(`Removed "${d.name}".`);
      await load();
    } catch (err) { toast(String(err), true); void load(); }
  };

  // Text and markdown notes only; binary formats (PDF) aren't supported yet.
  const pickFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setContent(String(reader.result ?? "")); if (!name.trim()) setName(f.name); };
    reader.onerror = () => toast(`Couldn't read ${f.name}.`, true);
    reader.readAsText(f);
  };

  return (
    <>
      <Topbar title="Knowledge" sub="Docs your agents search while they work — locally, offline">
        <div className="kb-toggle">
          <span>Agents read these docs</span>
          <Switch checked={enabled} onChange={(v) => void toggle(v)} label="Agents read these docs" />
        </div>
      </Topbar>
      <div className="view">
        {!enabled && docs !== null && (
          <p className="kb-note" role="status">
            Off — turn on “Agents read these docs” to wire the knowledge base into your agents’ next run.
          </p>
        )}
        <div className="kb-layout">
          <section className="card kb-form" aria-labelledby="kb-add-title">
            <h2 id="kb-add-title" className="card-title">Add a document</h2>
            <div className="field">
              <label className="field-label" htmlFor="kb-name">Name</label>
              <input id="kb-name" className="input" value={name} placeholder="tva-belgique.md"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field kb-body-field">
              <label className="field-label" htmlFor="kb-body">Content</label>
              <textarea id="kb-body" className="input kb-body" value={content}
                placeholder="Paste a business rule, a domain note, a runbook…"
                onChange={(e) => setContent(e.target.value)} />
            </div>
            <div className="row">
              <input ref={fileRef} type="file" accept=".md,.txt,.csv,.json,text/*" hidden onChange={pickFile} />
              <Btn kind="ghost" onClick={() => fileRef.current?.click()}><FileText size={15} /> Import a text file</Btn>
              <div className="spacer" />
              <Btn kind="fill" onClick={add} busy={busy} disabled={!name.trim() || !content.trim()}>
                {busy ? "Ingesting…" : "Add to knowledge"}
              </Btn>
            </div>
          </section>
          <DocList docs={docs} loadError={loadError} onRemove={remove} />
        </div>
      </div>
    </>
  );
}
