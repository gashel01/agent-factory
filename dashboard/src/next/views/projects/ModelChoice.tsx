/** The starting model for a project's coding agents — an explicit choice, never
 *  a silent default: it sets both the quality of the work and what a run costs.
 *  Opus and Sonnet are the recommended picks; Haiku is there for simple work. */

import type { JSX } from "react";
import { Seg } from "../../ui.js";

export type StartingModel = "" | "opus" | "sonnet" | "haiku";

const WHY: Record<Exclude<StartingModel, "">, string> = {
  opus: "Strongest on hard, multi-file tickets. Costs about twice Sonnet.",
  sonnet: "Strong on most tickets at about half Opus’s cost.",
  haiku: "Cheapest and fastest — fine for small, well-scoped edits, weaker on the rest.",
};

export function ModelChoice({ value, onChange }: { value: StartingModel; onChange: (v: StartingModel) => void }): JSX.Element {
  return (
    <div className="field">
      <span className="field-label">Starting model · required</span>
      <Seg label="Starting model" value={value} onChange={onChange}
        options={[
          { value: "opus", label: "Opus · recommended" },
          { value: "sonnet", label: "Sonnet · recommended" },
          { value: "haiku", label: "Haiku" },
        ]} />
      <span className="hint">
        {value ? WHY[value] : "We recommend Opus or Sonnet. You can change it later in Settings."}
      </span>
    </div>
  );
}
