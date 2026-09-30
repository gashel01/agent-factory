/** Capsule consents and icons.
 *
 *  A consent is a host mutation (install an SDK, set env). The operator sees
 *  the RAW facts — URLs, checksums, paths, env, commands — verbatim, never the
 *  agent's paraphrase: that is the anti-injection contract (a hostile repo
 *  can't dress a dangerous install up as something benign). */

import type { JSX } from "react";
import type { CapsuleConsent } from "../../../types.js";
import { Check, ExternalLink, Eye, Play, Smartphone, TriangleAlert } from "../../icons.js";
import { Btn } from "../../ui.js";

/** Safe icon allow-list — the capsule names an icon, it never emits UI. */
export function capsuleIcon(name: string | undefined, size = 15): JSX.Element {
  switch (name) {
    case "smartphone": case "phone": return <Smartphone size={size} />;
    case "external": case "link": case "download": return <ExternalLink size={size} />;
    case "eye": case "preview": return <Eye size={size} />;
    default: return <Play size={size} />;
  }
}

function Facts({ label, items }: { label: string; items: string[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="rn-facts">
      <span className="label">{label}</span>
      <ul>{items.map((x, i) => <li key={i}><code className="mono">{x}</code></li>)}</ul>
    </div>
  );
}

export function ConsentCard({ consent, onApprove }: { consent: CapsuleConsent; onApprove: () => Promise<void> }): JSX.Element {
  const f = consent.facts;
  return (
    <article className="card rn-consent" aria-label={`Approval needed: ${consent.title}`}>
      <div className="row rn-consent-title"><TriangleAlert size={16} aria-hidden="true" /><b>{consent.title}</b></div>
      {consent.summary && <p className="hint">{consent.summary}</p>}
      <p className="faint rn-small">Exactly what approving runs on this machine:</p>
      <Facts label="Downloads" items={(f.downloads ?? []).map((d) => d.sha256 ? `${d.url}  · sha256 ${d.sha256}` : d.url)} />
      <Facts label="Writes" items={f.writes ?? []} />
      <Facts label="Environment" items={Object.entries(f.env ?? {}).map(([k, v]) => `${k}=${v}`)} />
      <Facts label="Added to PATH" items={f.path ?? []} />
      <Facts label="Commands" items={f.commands ?? []} />
      <div className="row"><Btn kind="fill" small onClick={onApprove}><Check size={14} /> Approve &amp; run</Btn></div>
    </article>
  );
}
