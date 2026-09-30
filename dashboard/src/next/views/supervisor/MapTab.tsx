/** The Map tab — the living architecture, the shared source of truth both the
 *  operator and the agents reference: the system map derived from the code, the
 *  sketch board, the world-model the agents maintain from what they land
 *  (decisions, symbols, files and who last touched them), and the notes YOU keep
 *  (agents read them for context). The map and the board open in a large
 *  overlay; everything else reads fine at panel width. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { FileText, Palette, Sparkles } from "../../icons.js";
import { Maximize2 } from "lucide-react";
import { Btn, Spinner } from "../../ui.js";
import { Expand } from "./Expand.js";
import { SketchBoard } from "./SketchBoard.js";
import { SystemMap } from "./SystemMap.js";
import type { ArchData } from "./types.js";

export function MapTab(): JSX.Element {
  const [data, setData] = useState<ArchData | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [big, setBig] = useState<"map" | "board" | null>(null);

  const load = (): void => {
    setFailed(false);
    void fetchJSON<ArchData>("/api/architecture")
      .then((d) => { setData(d); setNotes(d.notes); setDirty(false); })
      .catch(() => setFailed(true));
  };
  useEffect(load, []);

  const save = async (): Promise<void> => {
    try {
      await fetchJSON("/api/architecture", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }),
      });
      setDirty(false);
      toast("Architecture notes saved.");
    } catch (err) { toast(String(err), true); }
  };

  if (failed) {
    return (
      <div className="sv-pane">
        <p className="hint">Couldn't load the architecture — is the Warden server still running?</p>
        <Btn small onClick={load}>Try again</Btn>
      </div>
    );
  }
  if (!data) return <div className="sv-pane sv-center"><Spinner /></div>;

  const map = data.map;
  const emptyMap = map.symbols.length === 0 && map.decisions.length === 0 && map.files.length === 0;

  return (
    <div className="sv-pane">
      {data.graph && (
        <section className="sv-block">
          <div className="sv-block-head">
            <h3 className="sv-h">System map</h3>
            <button type="button" className="iconbtn sm" aria-label="Open the system map full size" title="Open full size"
              onClick={() => setBig("map")}><Maximize2 size={15} /></button>
          </div>
          <p className="sv-sub">Files and imports, by role — derived from the code.</p>
          <SystemMap graph={data.graph} />
        </section>
      )}

      <section className="sv-block">
        <div className="sv-block-head">
          <h3 className="sv-h">Sketch board</h3>
          <Btn small onClick={() => setBig("board")}><Palette size={14} /> Open board</Btn>
        </div>
        <p className="sv-sub">Sketch the system together, or drop the system map as movable nodes.</p>
      </section>

      <section className="sv-block">
        <h3 className="sv-h">World-model</h3>
        <p className="sv-sub"><Sparkles size={12} aria-hidden /> Maintained by your agents from what they land — grows every run.</p>
        {emptyMap
          ? <p className="hint">Nothing mapped yet. As agents land work, the symbols they publish, the decisions they
              record, and the files they own show up here automatically.</p>
          : (
            <>
              {map.decisions.length > 0 && (
                <details className="sv-fold" open>
                  <summary className="sv-fold-head">Decisions <span className="sv-count">{map.decisions.length}</span></summary>
                  <ul className="sv-list">
                    {map.decisions.map((d) => (
                      <li key={d.key}><b>{d.key}</b>: {d.value} <span className="sv-by">#{d.ticket}</span></li>
                    ))}
                  </ul>
                </details>
              )}
              {map.symbols.length > 0 && (
                <details className="sv-fold" open>
                  <summary className="sv-fold-head">Symbols <span className="sv-count">{map.symbols.length}</span></summary>
                  <ul className="sv-list">
                    {map.symbols.map((s) => (
                      <li key={`${s.name}@${s.file}`}><b>{s.name}</b> <span className="faint">→</span> <span className="mono">{s.file}</span></li>
                    ))}
                  </ul>
                </details>
              )}
              {map.files.length > 0 && (
                <details className="sv-fold">
                  <summary className="sv-fold-head">Files &amp; who last touched them <span className="sv-count">{map.files.length}</span></summary>
                  <ul className="sv-list">
                    {map.files.map((f) => (
                      <li key={f.file} className="sv-file">
                        <FileText size={12} aria-hidden /> <span className="mono sv-file-name">{f.file}</span> <span className="sv-by">#{f.ticket}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
      </section>

      <section className="sv-block">
        <div className="sv-block-head">
          <label className="sv-h" htmlFor="sv-notes">Your notes</label>
          <Btn small kind="fill" onClick={save} disabled={!dirty}>Save</Btn>
        </div>
        <p className="sv-sub">The architecture as you see it — conventions, intent, the “why”. Agents read this for context.</p>
        <textarea id="sv-notes" className="input mono sv-notes" value={notes}
          placeholder="Write the conventions agents should follow — where shared types live, naming rules, what never to touch."
          onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
      </section>

      {big === "map" && data.graph && (
        <Expand title="System map" sub="Files and imports, by role — derived from the code." onClose={() => setBig(null)}>
          <SystemMap graph={data.graph} big />
        </Expand>
      )}
      {big === "board" && <SketchBoard onClose={() => setBig(null)} />}
    </div>
  );
}
