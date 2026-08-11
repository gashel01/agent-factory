import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "./api.js";
import { FileText, Sparkles } from "./icons.js";
import { Skeleton, toast, Button } from "./core.js";
import { Modal } from "./widgets.js";

interface ArchData {
  map: {
    symbols: Array<{ name: string; file: string }>;
    decisions: Array<{ key: string; value: string; ticket: string }>;
    files: Array<{ file: string; ticket: string }>;
  };
  notes: string;
}

/** The living architecture: the world-model your agents maintain (folded from
 *  every run — which symbol lives where, the decisions taken, which ticket owns
 *  each file) next to the notes YOU keep. The shared source of truth both sides
 *  reference, and it survives runs. */
export function ArchitectureModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<ArchData | null>(null);
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void fetchJSON<ArchData>("/api/architecture")
      .then((d) => { setData(d); setNotes(d.notes); })
      .catch(() => {});
  }, []);

  const save = async (): Promise<void> => {
    try {
      await fetchJSON("/api/architecture", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      setDirty(false);
      toast("Architecture notes saved.");
    } catch (err) { toast(String(err), true); }
  };

  const map = data?.map;
  const emptyMap = map && map.symbols.length === 0 && map.decisions.length === 0 && map.files.length === 0;

  return (
    <Modal title="Architecture — the shared source of truth" onClose={onClose} wide>
      {!data
        ? <div className="panel-body"><Skeleton lines={6} /></div>
        : (
          <div className="arch">
            <section className="arch-map">
              <p className="arch-lead"><Sparkles size={13} /> Maintained by your agents from what they land — grows every run.</p>
              {emptyMap
                ? <p className="hint">Nothing mapped yet. As agents land work, the symbols they publish, the
                    decisions they record, and the files they own show up here automatically.</p>
                : (
                  <>
                    {map!.decisions.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Decisions</h4>
                        <ul className="arch-list">
                          {map!.decisions.map((d) => (
                            <li key={d.key}><b>{d.key}</b>: {d.value} <span className="arch-by">#{d.ticket}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {map!.symbols.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Symbols</h4>
                        <ul className="arch-list">
                          {map!.symbols.map((s) => (
                            <li key={`${s.name}@${s.file}`}><b>{s.name}</b> <span className="arch-arrow">→</span> <span className="mono">{s.file}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {map!.files.length > 0 && (
                      <div className="arch-block">
                        <h4 className="arch-h">Files &amp; who last touched them</h4>
                        <ul className="arch-files">
                          {map!.files.map((f) => (
                            <li key={f.file}><FileText size={12} /> <span className="mono arch-file-nm">{f.file}</span> <span className="arch-by">#{f.ticket}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
            </section>

            <section className="arch-notes">
              <div className="arch-notes-head">
                <h4 className="arch-h">Your notes</h4>
                <Button kind="btn" variant="primary" onClick={() => void save()} disabled={!dirty}>Save</Button>
              </div>
              <p className="arch-lead">The architecture as you see it — conventions, intent, the “why”. Agents read this for context.</p>
              <textarea className="input arch-textarea" value={notes}
                placeholder={"# Architecture\n\n- The header nav lives in ProjectSwitcher…\n- Modals are extracted into *-modal.tsx, re-exported from modals.tsx…"}
                onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
            </section>
          </div>
        )}
    </Modal>
  );
}
