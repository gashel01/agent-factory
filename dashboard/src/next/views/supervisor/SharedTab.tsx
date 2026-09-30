/** The Shared tab — the shared workspace made visible: which agent is editing
 *  which files right now (its claims), the symbols published into the
 *  world-model so siblings import instead of redefining, the decisions they
 *  share, and the notes they pass to one another. Polls while the tab is open
 *  so it feels live (same cadence as the classic view). */

import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { usePolling } from "../../../core.js";
import { Users } from "lucide-react";
import { FileText, MessageSquare } from "../../icons.js";
import { Empty, Spinner, Tag } from "../../ui.js";
import type { CoordData } from "./types.js";

/** Refresh cadence of the shared-space view. */
const COORDINATION_POLL_MS = 4000;
/** Files listed per agent before folding the rest into "+N more". */
const FILES_SHOWN = 8;

const AGENT_STATE: Record<string, { label: string; color: string }> = {
  live: { label: "editing now", color: "var(--st-working)" },
  landed: { label: "merged", color: "var(--st-merged)" },
  released: { label: "stopped", color: "var(--st-queued)" },
};

export function SharedTab(): JSX.Element {
  const [data, setData] = useState<CoordData | null>(null);
  const [failed, setFailed] = useState(false);

  usePolling(async ({ alive }) => {
    try {
      const d = await fetchJSON<CoordData>("/api/coordination");
      if (alive()) { setData(d); setFailed(false); }
    } catch { if (alive()) setFailed(true); }
  }, COORDINATION_POLL_MS, []);

  if (!data) {
    return failed
      ? <div className="sv-pane"><p className="hint">Couldn't reach the shared space — retrying every few seconds.</p></div>
      : <div className="sv-pane sv-center"><Spinner /></div>;
  }
  const empty = data.agents.length === 0 && data.symbols.length === 0
    && data.decisions.length === 0 && data.discoveries.length === 0;
  if (empty) {
    return (
      <div className="sv-pane">
        <Empty icon={<Users size={22} />} title="Nothing shared yet">
          During a run this shows which agent is editing which files, the symbols they've published (so siblings
          import instead of redefining), and the decisions and notes they pass to one another.
        </Empty>
      </div>
    );
  }

  return (
    <div className="sv-pane">
      {failed && <p className="hint">Connection hiccup — showing the last known state.</p>}
      {data.agents.length > 0 && (
        <section className="sv-block">
          <h3 className="sv-h">Agents &amp; the files they hold</h3>
          <ul className="sv-agents">
            {data.agents.map((a) => {
              const st = AGENT_STATE[a.state] ?? { label: a.state, color: "var(--st-queued)" };
              return (
                <li key={a.ticket} className={`sv-agent ${a.state}`} style={{ "--c": st.color } as CSSProperties}>
                  <div className="sv-agent-top">
                    <span className="sv-need-id">#{a.ticket}</span>
                    <Tag color={st.color} dot>{st.label}</Tag>
                  </div>
                  {a.files.length > 0 && (
                    <ul className="sv-list">
                      {a.files.slice(0, FILES_SHOWN).map((f) => (
                        <li key={f} className="sv-file"><FileText size={12} aria-hidden /> <span className="mono sv-file-name">{f}</span></li>
                      ))}
                      {a.files.length > FILES_SHOWN && <li className="faint">+{a.files.length - FILES_SHOWN} more</li>}
                    </ul>
                  )}
                  {a.symbols.length > 0 && <p className="sv-sub">published {a.symbols.join(", ")}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {data.symbols.length > 0 && (
        <section className="sv-block">
          <h3 className="sv-h">Symbols in the world-model</h3>
          <p className="sv-sub">Already defined — siblings import these instead of recreating them.</p>
          <ul className="sv-list">
            {data.symbols.map((s) => (
              <li key={`${s.name}@${s.file}`}><b>{s.name}</b> <span className="faint">→</span> <span className="mono">{s.file}</span></li>
            ))}
          </ul>
        </section>
      )}
      {data.decisions.length > 0 && (
        <section className="sv-block">
          <h3 className="sv-h">Shared decisions</h3>
          <ul className="sv-list">
            {data.decisions.map((d) => (
              <li key={d.key}><b>{d.key}</b>: {d.value} <span className="sv-by">#{d.ticket}</span></li>
            ))}
          </ul>
        </section>
      )}
      {data.discoveries.length > 0 && (
        <section className="sv-block">
          <h3 className="sv-h"><MessageSquare size={13} aria-hidden /> Notes between agents</h3>
          <ul className="sv-list">
            {data.discoveries.map((n, i) => <li key={i}>{n.note} <span className="sv-by">#{n.ticket}</span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
