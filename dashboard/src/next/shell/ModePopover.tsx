/** "How this project runs", opened from the plan card in the rail: execution
 *  mode, delivery, and the plan's usage windows. Changing a setting goes through
 *  Settings, which owns the project's factory.yaml. */

import type { JSX, ReactNode } from "react";
import { Check } from "../icons.js";
import { fmtReset, limitLabel, usePlanLimits } from "../../control.js";
import { useWarden } from "../data.js";
import { Bar, Btn } from "../ui.js";

function Choice({ on, title, detail }: { on: boolean; title: string; detail: string }): JSX.Element {
  return (
    <div className="menu-item" style={{ alignItems: "flex-start", cursor: "default" }} aria-current={on || undefined}>
      {on ? <Check size={17} style={{ color: "var(--st-merged)", marginTop: 2 }} /> : <span style={{ width: 17 }} />}
      <span className="stack" style={{ gap: 2 }}>
        <b style={{ fontSize: 14, color: on ? "var(--text)" : "var(--dim)" }}>{title}</b>
        <span className="hint" style={{ fontSize: 12.5 }}>{detail}</span>
      </span>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <div className="stack" style={{ gap: 6 }}><span className="label" style={{ padding: "0 12px" }}>{label}</span>{children}</div>;
}

export function ModePopover({ from }: { from: "rail" | "top" }): JSX.Element {
  const w = useWarden();
  const limits = usePlanLimits(true);
  const api = w.model.mode === "api";
  const pr = w.model.prMode === true;
  return (
    <>
      <div className="scrim" style={{ background: "transparent", backdropFilter: "none" }} onClick={w.close} aria-hidden="true" />
      <div className="popover" role="dialog" aria-label="How this project runs"
        style={{ ...(from === "top" ? { right: 24, top: 72 } : { left: 18, bottom: 110 }), width: 380, display: "grid", gap: 14, padding: 14 }}>
        <b style={{ fontSize: 15, padding: "2px 12px" }}>How this project runs</b>
        <Section label="Execution">
          <Choice on={!api} title="Subscription" detail="Draws from your Claude plan. Costs shown are estimates." />
          <Choice on={api} title="API key" detail="Uses the key in your environment and bills real dollars." />
        </Section>
        <div className="divider" />
        <Section label="Delivery">
          <Choice on={!pr} title="Integrated" detail="Verified tickets merge into the base branch, one at a time." />
          <Choice on={pr} title="A pull request per ticket" detail="The base branch moves only when you merge." />
        </Section>
        {limits.length > 0 && (
          <>
            <div className="divider" />
            <Section label="Plan usage">
              {limits.map((l) => (
                <div key={l.kind + (l.scope?.model?.display_name ?? "")} className="stack" style={{ gap: 5, padding: "4px 12px" }}>
                  <span className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                    <span className="dim">{limitLabel(l)}</span>
                    <b>{Math.round(l.percent)}%{l.resets_at ? <span className="faint" style={{ fontWeight: 400 }}> · {fmtReset(l.resets_at)}</span> : null}</b>
                  </span>
                  <Bar segments={[{ pct: l.percent, color: l.percent >= 90 ? "var(--st-needs)" : l.percent >= 70 ? "var(--st-review)" : "var(--st-merged)", label: limitLabel(l) }]} />
                </div>
              ))}
            </Section>
          </>
        )}
        <Btn small onClick={() => { w.close(); w.go("settings", "safety"); }}>Change in Settings</Btn>
      </div>
    </>
  );
}
