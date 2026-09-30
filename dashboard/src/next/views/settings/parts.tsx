/** Building blocks shared by every Settings section: a titled group card, a
 *  label-plus-hint row with its control on the right, and a segmented picker
 *  that never hides a value it doesn't list (a hand-edited factory.yaml may hold
 *  "opus-4" or 7 slots — it shows up as its own choice instead of vanishing). */

import type { JSX, ReactNode } from "react";
import { Seg } from "../../ui.js";

export function Group({ title, sub, children }: { title?: string; sub?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="card st-group">
      {title && (
        <header className="st-group-head">
          <h2 className="card-title">{title}</h2>
          {sub && <p className="hint">{sub}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function SettingRow({ label, hint, children, htmlFor, stacked }: {
  label: string; hint: ReactNode; children: ReactNode; htmlFor?: string; stacked?: boolean;
}): JSX.Element {
  return (
    <div className={`st-row${stacked ? " stacked" : ""}`}>
      <div className="st-row-text">
        {htmlFor ? <label className="st-row-label" htmlFor={htmlFor}>{label}</label> : <b className="st-row-label">{label}</b>}
        <p className="hint">{hint}</p>
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

/** A Seg over string choices, keeping an unlisted current value selectable. */
export function ChoiceSeg({ value, choices, onChange, label }: {
  value: string; choices: Array<[string, string]>; onChange: (v: string) => void; label: string;
}): JSX.Element {
  const all = choices.some(([v]) => v === value) ? choices : [...choices, [value, value] as [string, string]];
  return <Seg label={label} value={value} onChange={onChange} options={all.map(([v, l]) => ({ value: v, label: l }))} />;
}

/** A Seg over small integers (slots, attempts, retries). */
export function NumberSeg({ value, choices, onChange, label }: {
  value: number; choices: number[]; onChange: (v: number) => void; label: string;
}): JSX.Element {
  const all = choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
  return (
    <Seg label={label} value={String(value)} onChange={(v) => onChange(Number(v))}
      options={all.map((n) => ({ value: String(n), label: String(n) }))} />
  );
}
