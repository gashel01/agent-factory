import type { JSX } from "react";
import type { CapsuleConsent } from "./types.js";
import { Check, ExternalLink, Eye, Play, Smartphone, TriangleAlert } from "./icons.js";
import { Button } from "./core.js";

/** Safe icon allow-list — the capsule references names, never emits UI code. */
export function capsuleIcon(name: string | undefined, size = 14): JSX.Element {
  switch (name) {
    case "smartphone": case "phone": return <Smartphone size={size} />;
    case "external": case "link": case "download": return <ExternalLink size={size} />;
    case "eye": case "preview": return <Eye size={size} />;
    default: return <Play size={size} />;
  }
}

/** A host-mutation approval: the user sees the RAW facts (URLs, checksums, paths,
 *  env, commands) verbatim — never the agent's paraphrase. Anti-injection contract. */
export function ConsentCard({ consent, onApprove }: { consent: CapsuleConsent; onApprove: () => void }): JSX.Element {
  const f = consent.facts;
  const list = (label: string, items: JSX.Element[]): JSX.Element | null =>
    items.length ? <div className="consent-group"><b>{label}</b><ul>{items}</ul></div> : null;
  return (
    <div className="consent-card">
      <div className="consent-title"><TriangleAlert size={15} /> {consent.title}</div>
      {consent.summary && <p className="phone-sub">{consent.summary}</p>}
      <div className="consent-facts">
        {list("Downloads", (f.downloads ?? []).map((d, i) => (
          <li key={i}><code>{d.url}</code>{d.sha256 && <span className="consent-sha"> · sha256 {d.sha256.slice(0, 16)}…</span>}</li>
        )))}
        {list("Writes", (f.writes ?? []).map((w, i) => <li key={i}><code>{w}</code></li>))}
        {list("Env", Object.entries(f.env ?? {}).map(([k, v]) => <li key={k}><code>{k}={v}</code></li>))}
        {list("Commands", (f.commands ?? []).map((c, i) => <li key={i}><code>{c}</code></li>))}
      </div>
      <div className="card-actions">
        <Button kind="btn" variant="primary" autoPending onClick={onApprove}><Check size={14} /> Approve &amp; run</Button>
      </div>
    </div>
  );
}
