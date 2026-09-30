/** Read-only capsule panels: a command whose output is shown (refreshable),
 *  or agent-authored HTML in a locked sandboxed iframe (scripts, but no
 *  same-origin — isolated from the dashboard). Classic cockpit-panel.tsx. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import type { CapsulePanel } from "../../../types.js";
import { RefreshCw } from "../../icons.js";
import { IconBtn, Spinner } from "../../ui.js";
import { plainError } from "../repo/errors.js";

function PanelCard({ panel }: { panel: CapsulePanel }): JSX.Element {
  const [out, setOut] = useState<string | null>(null);
  const load = (): void => {
    if (panel.html !== undefined) return; // html panels are static, nothing to fetch
    setOut(null);
    fetchJSON<{ output: string }>(`/api/capsule/panel?id=${encodeURIComponent(panel.id)}`)
      .then((r) => setOut(r.output.trim() || "(no output)"))
      .catch((e) => setOut(plainError(e, "Couldn't run this panel.").text));
  };
  useEffect(load, [panel.id]);
  return (
    <article className="card tight rn-panel">
      <div className="row">
        <b className="rn-panel-title">{panel.title}</b>
        <div className="spacer" />
        {panel.html === undefined && <IconBtn small label={`Refresh ${panel.title}`} onClick={load}><RefreshCw size={13} /></IconBtn>}
      </div>
      {panel.html !== undefined
        ? <iframe className="rn-panel-html" sandbox="allow-scripts" srcDoc={panel.html} title={panel.title} />
        : out === null ? <Spinner /> : <pre className="rn-log rn-panel-body">{out}</pre>}
    </article>
  );
}

export function Panels({ panels }: { panels: CapsulePanel[] }): JSX.Element | null {
  if (panels.length === 0) return null;
  return (
    <section className="stack rn-gap-8" aria-label="Panels">
      <span className="label">Panels</span>
      <div className="rn-panels">{panels.map((p) => <PanelCard key={p.id} panel={p} />)}</div>
    </section>
  );
}
