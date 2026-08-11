import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "./api.js";
import { FileText, MessageSquare } from "./icons.js";
import { Skeleton } from "./core.js";
import { Modal } from "./widgets.js";

interface CoordAgent { ticket: string; files: string[]; state: "live" | "landed" | "released"; symbols: string[] }
interface CoordData {
  run: string | null;
  agents: CoordAgent[];
  symbols: Array<{ name: string; file: string; ticket: string }>;
  decisions: Array<{ key: string; value: string; ticket: string }>;
  discoveries: Array<{ ticket: string; note: string }>;
}

const STATE_LABEL: Record<string, string> = { live: "editing now", landed: "merged", released: "stopped" };

/** The shared workspace, made visible: which agent is touching which files right
 *  now, the symbols they've published into the world-model, and the decisions and
 *  notes they pass to each other. Polls so it feels live. */
export function CoordinationModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<CoordData | null>(null);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      void fetchJSON<CoordData>("/api/coordination").then((d) => { if (live) setData(d); }).catch(() => {});
    };
    load();
    const id = window.setInterval(load, 4000);
    return () => { live = false; window.clearInterval(id); };
  }, []);

  const empty = data && data.agents.length === 0 && data.symbols.length === 0
    && data.decisions.length === 0 && data.discoveries.length === 0;

  return (
    <Modal title="Shared space — how your agents coordinate" onClose={onClose} wide>
      {!data
        ? <div className="panel-body"><Skeleton lines={6} /></div>
        : empty
          ? <p className="hint">Nothing shared yet. During a run this shows which agent is editing which
              files, the symbols they've published (so siblings import instead of redefining), and the
              decisions and notes they pass to one another.</p>
          : (
            <div className="coord">
              <section className="coord-live">
                <h4 className="coord-h">Agents &amp; the files they own</h4>
                <div className="coord-agents">
                  {data.agents.map((a) => (
                    <div key={a.ticket} className={`coord-agent ${a.state}`}>
                      <div className="coord-agent-top">
                        <span className="coord-tk">#{a.ticket}</span>
                        <span className={`coord-state ${a.state}`}>
                          {a.state === "live" && <span className="coord-pulse" aria-hidden="true" />}
                          {STATE_LABEL[a.state] ?? a.state}
                        </span>
                      </div>
                      {a.files.length > 0 && (
                        <ul className="coord-files">
                          {a.files.slice(0, 8).map((f) => (
                            <li key={f}><FileText size={12} /> <span className="coord-file-nm">{f}</span></li>
                          ))}
                          {a.files.length > 8 && <li className="coord-more">+{a.files.length - 8} more</li>}
                        </ul>
                      )}
                      {a.symbols.length > 0 && (
                        <div className="coord-agent-syms">published {a.symbols.join(", ")}</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <aside className="coord-know">
                {data.symbols.length > 0 && (
                  <div className="coord-block">
                    <h4 className="coord-h">Symbols in the world-model</h4>
                    <p className="coord-sub">Already defined — siblings import these instead of recreating them.</p>
                    <ul className="coord-syms">
                      {data.symbols.map((s) => (
                        <li key={`${s.name}@${s.file}`}>
                          <b>{s.name}</b> <span className="coord-arrow">→</span> <span className="mono">{s.file}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.decisions.length > 0 && (
                  <div className="coord-block">
                    <h4 className="coord-h">Shared decisions</h4>
                    <ul className="coord-decisions">
                      {data.decisions.map((d) => (
                        <li key={d.key}><b>{d.key}</b>: {d.value} <span className="coord-by">#{d.ticket}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.discoveries.length > 0 && (
                  <div className="coord-block">
                    <h4 className="coord-h"><MessageSquare size={13} /> Notes between agents</h4>
                    <ul className="coord-notes">
                      {data.discoveries.map((n, i) => (
                        <li key={i}>{n.note} <span className="coord-by">#{n.ticket}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </aside>
            </div>
          )}
    </Modal>
  );
}
