/** "Proven by": the ticket's verify command. Verification is required by
 *  default — a ticket with no command of its own falls back to the project's
 *  default checks, and with neither it can't be marked done unless it skips
 *  verification. The hint says which of those applies to THIS project, read
 *  from its factory.yaml. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { parseSettings } from "../../../model.js";
import { useWarden } from "../../data.js";

export interface VerifyPolicy { require: boolean; defaults: string }

/** The project's verify policy; null until factory.yaml answered. */
export function useVerifyPolicy(): VerifyPolicy | null {
  const w = useWarden();
  const [p, setP] = useState<VerifyPolicy | null>(null);
  useEffect(() => {
    let alive = true;
    fetchJSON<{ content: string }>("/api/config")
      .then(({ content }) => {
        const s = parseSettings(content);
        if (alive) setP({ require: s.requireVerify, defaults: s.verifyCommands });
      })
      .catch(() => { /* offline: the field still works, only the hint is generic */ });
    return () => { alive = false; };
  }, [w.ws]);
  return p;
}

export function ProvenBy({ id, value, onChange, skip, onSkip, policy }: {
  id: string; value: string; onChange: (v: string) => void;
  skip: boolean; onSkip: (v: boolean) => void; policy: VerifyPolicy | null;
}): JSX.Element {
  const empty = !value.trim();
  const hint = skip
    ? "Verification skipped for this ticket — you'll check the change yourself."
    : !empty
      ? "Commands that exit 0 when the work is right. Comma-separated."
      : policy?.defaults
        ? <>Empty uses the project's default checks: <span className="mono">{policy.defaults}</span>.</>
        : policy && !policy.require
          ? "Optional here — this project accepts a ticket on its diff alone."
          : "A command that exits 0 when the work is right. Without one, the ticket can’t be marked done.";
  const warn = !skip && empty && policy?.require === true && !policy.defaults;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>Proven by</label>
      <input id={id} className="input mono" placeholder="npm test" value={value} disabled={skip}
        onChange={(e) => onChange(e.target.value)} />
      <p className={`hint${warn ? " nw-warn" : ""}`}>{hint}</p>
      <label className="nw-check">
        <input type="checkbox" checked={skip} onChange={(e) => onSkip(e.target.checked)} />
        No automated check — I’ll verify this one myself
      </label>
    </div>
  );
}
