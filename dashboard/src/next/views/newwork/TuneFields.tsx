/** Per-ticket overrides of the run-wide defaults from Settings: model, thinking
 *  effort, and skipping the AI reviewer. Used by New work and Edit ticket;
 *  pure controls, the parent decides when to write the front matter. */

import type { JSX } from "react";
import { EFFORT_CHOICES, MODEL_CHOICES } from "../../../model.js";
import { Pills } from "../../ui.js";

/** Keep a hand-written value the lists don't know about selectable. */
function withCurrent(choices: Array<[string, string]>, value: string): Array<[string, string]> {
  return !value || choices.some(([v]) => v === value) ? choices : [...choices, [value, value]];
}

const modelLabel = (v: string, l: string): string => (v ? l.split(" — ")[0]! : "Default");

export function ModelPills({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div className="nw-tune-row">
      <span className="label">Model</span>
      <Pills label="Model for this ticket" value={value} onChange={onChange}
        options={withCurrent(MODEL_CHOICES, value).map(([v, l]) => ({ value: v, label: modelLabel(v, l) }))} />
    </div>
  );
}

export function EffortPills({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div className="nw-tune-row">
      <span className="label">Effort</span>
      <Pills label="Thinking effort for this ticket" value={value} onChange={onChange}
        options={withCurrent(EFFORT_CHOICES, value).map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  );
}
