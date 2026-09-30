/** One capsule action as a card: what it runs (its real command lines), its
 *  state, and its verbs — Run (or Start/Stop for a long-running service), Open
 *  for a preview/link surface, "Ask AI to fix" after a failure, the behavioral
 *  judge when the capsule declares acceptance criteria, and the device install
 *  once an artifact exists. Its output shows in the stage on the right. */

import type { CSSProperties, JSX } from "react";
import { api } from "../../../api.js";
import type { CapsuleAction, CapsuleView } from "../../../types.js";
import { Check, ExternalLink, Eye, Sparkles, Square, Terminal, X } from "../../icons.js";
import { Btn, Tag } from "../../ui.js";
import { capsuleIcon } from "./Consent.js";
import { DeviceInstall } from "./Device.js";
import type { Cockpit } from "./useCapsule.js";

const STATE_TAG: Record<string, { text: string; color: string }> = {
  running: { text: "running", color: "var(--st-working)" },
  ok: { text: "passed", color: "var(--st-merged)" },
  error: { text: "failed", color: "var(--st-needs)" },
  starting: { text: "starting", color: "var(--st-working)" },
  live: { text: "live", color: "var(--st-merged)" },
};

function Judge({ a, c }: { a: CapsuleAction; c: Cockpit }): JSX.Element | null {
  if (!a.judge) return null;
  const j = c.judge[a.id];
  return (
    <div className="stack rn-judge">
      <div className="row rn-wrap">
        <Btn small busy={j?.state === "running"} onClick={() => c.runJudge(a)}>
          <Eye size={14} /> {j?.state === "running" ? "Judging…" : "Judge (AI)"}
        </Btn>
        <span className="faint rn-small" title={a.judge}>Checks: {a.judge}</span>
      </div>
      {j?.state === "done" && j.verdict && (
        <div className="stack rn-gap-6">
          <Tag color={j.verdict === "pass" ? "var(--st-merged)" : "var(--st-needs)"}>
            {j.verdict === "pass" ? <Check size={12} /> : <X size={12} />} {j.verdict === "pass" ? "Passes" : "Fails"}
            {j.confidence != null ? ` · ${Math.round(j.confidence * 100)}% sure` : ""}
          </Tag>
          {j.reasons.length > 0 && <ul className="rn-reasons">{j.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          {j.hasShot && <img className="rn-shot" src={api(`/api/capsule/judge/shot?id=${encodeURIComponent(a.id)}`)} alt={`What the judge saw for ${a.label}`} />}
        </div>
      )}
    </div>
  );
}

export function ActionCard({ a, c, view, selected, onSelect }: {
  a: CapsuleAction; c: Cockpit; view: CapsuleView; selected: boolean; onSelect: () => void;
}): JSX.Element {
  const gated = !!a.consent && !view.grants.includes(a.consent);
  const svc = a.service ? (c.svc[a.id] ?? view.services?.[a.id] ?? { state: "stopped", url: null }) : null;
  const rs = view.runs[a.id];
  const running = c.running.has(a.id) || rs?.state === "running";
  const state = svc ? (svc.state === "stopped" ? "" : svc.state) : running ? "running" : rs?.state ?? "";
  const tag = STATE_TAG[state];
  const hasOutput = Boolean(svc ? c.svcOut[a.id] : (c.logs[a.id] ?? rs?.output));
  const command = a.steps.map((s) => s.run).join("  &&  ");
  const tint = a.primary ? "var(--accent)" : tag?.color;

  return (
    <article className="card rn-action" aria-current={selected ? "true" : undefined}>
      <div className="rn-action-row">
        <span className="rn-action-ic" style={tint ? ({ "--c": tint } as CSSProperties) : undefined} aria-hidden="true">{capsuleIcon(a.icon)}</span>
        <div className="stack rn-gap-2">
          <b className="rn-action-name">{a.label}</b>
          {command && <span className="mono faint rn-cmd" title={command}>{command}</span>}
        </div>
        {tag && <Tag color={tag.color} dot>{tag.text}</Tag>}
      </div>
      {a.description && <p className="hint">{a.description}</p>}
      <div className="row rn-wrap">
        {svc ? (
          svc.state === "live" || svc.state === "starting"
            ? <Btn small kind="danger" onClick={() => c.stopSvc(a)}><Square size={13} /> Stop</Btn>
            : <Btn small kind={a.primary ? "fill" : "default"} disabled={gated} onClick={() => { onSelect(); return c.startSvc(a); }}>{capsuleIcon(a.icon, 13)} Start</Btn>
        ) : (
          <Btn small kind={a.primary ? "fill" : "default"} disabled={running || gated} onClick={() => { onSelect(); return c.runAction(a); }}>
            {capsuleIcon(a.icon, 13)} {running ? "Running…" : "Run"}
          </Btn>
        )}
        {svc?.url && <Btn small onClick={() => { window.open(svc.url!, "_blank"); }}><ExternalLink size={13} /> Open</Btn>}
        {!svc && a.surface === "preview" && a.url && (
          <Btn small onClick={() => { window.open(a.url!.replace("${lan}", c.lanBase), "_blank"); }}><Eye size={13} /> Open</Btn>
        )}
        {!svc && rs?.state === "error" && !running && (
          <Btn small kind="fill" onClick={() => { onSelect(); return c.fixAction(a); }}><Sparkles size={13} /> Ask AI to fix</Btn>
        )}
        {hasOutput && !selected && <Btn small kind="ghost" onClick={onSelect}><Terminal size={13} /> Output</Btn>}
      </div>
      {gated && <p className="rn-gate">Approve “{a.consent}” above first.</p>}
      {a.surface === "device-install" && rs?.artifactReady && (
        <DeviceInstall action={a} devices={view.devices?.[a.id] ?? []} lanBase={c.lanBase} />
      )}
      <Judge a={a} c={c} />
    </article>
  );
}
