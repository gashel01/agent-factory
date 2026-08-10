import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { CapsulePanel } from "./types.js";
import { fetchJSON } from "./api.js";
import { RotateCw } from "./icons.js";

export function PanelCard({ panel }: { panel: CapsulePanel }): JSX.Element {
  const [out, setOut] = useState<string | null>(null);
  const load = (): void => {
    if (panel.html !== undefined) return; // html panels are static, nothing to fetch
    setOut(null);
    void fetchJSON<{ output: string }>(`/api/capsule/panel?id=${encodeURIComponent(panel.id)}`)
      .then((r) => setOut(r.output.trim() || "(no output)")).catch((e) => setOut(String(e)));
  };
  useEffect(load, [panel.id]);
  return (
    <div className="cockpit-panel">
      <div className="cockpit-panel-head">
        <span>{panel.title}</span>
        {panel.html === undefined && <button className="btn icon" title="Refresh" onClick={load}><RotateCw size={12} /></button>}
      </div>
      {panel.html !== undefined
        // Sandboxed: scripts run but no same-origin — isolated from the dashboard.
        ? <iframe className="cockpit-panel-html" sandbox="allow-scripts" srcDoc={panel.html} title={panel.title} />
        : <pre className="cockpit-panel-body">{out ?? "…"}</pre>}
    </div>
  );
}
