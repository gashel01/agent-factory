/** Settings › General: what kind of project it is, which model codes, how many
 *  agents at once, best-of-N attempts and the run budget. */

import type { JSX } from "react";
import { MODEL_CHOICES } from "../../../model.js";
import type { Settings } from "../../../model.js";
import { ChoiceSeg, Group, NumberSeg, SettingRow } from "./parts.js";

export interface SectionProps { s: Settings; set: (patch: Partial<Settings>) => void }

const PROJECT_TYPES: Array<[Settings["project"], string]> = [["node", "Node / JS"], ["python", "Python"], ["other", "Other"]];

/** Short labels for the segmented control; the long ones live in the hint. */
const shortModel = (label: string): string => label.split(" — ")[0]!.replace(" (CLI's choice)", "");

export function GeneralSection({ s, set }: SectionProps): JSX.Element {
  return (
    <Group>
      <SettingRow label="Project type" hint="Picks the matching build tools and the default dependency install.">
        <ChoiceSeg label="Project type" value={s.project} choices={PROJECT_TYPES}
          onChange={(v) => {
            const project = v as Settings["project"];
            set({ project, setupCommands: project === "node" ? "npm install" : project === "python" ? "uv sync" : "" });
          }} />
      </SettingRow>
      <SettingRow label="Coding model"
        hint="The starting model for every coding agent — cheapest is fine: a ticket that fails its check retries on a stronger tier (haiku → sonnet → opus). A ticket can still pin its own.">
        <ChoiceSeg label="Coding model" value={s.model} onChange={(v) => set({ model: v })}
          choices={MODEL_CHOICES.map(([v, l]) => [v, shortModel(l)])} />
      </SettingRow>
      <SettingRow label="Parallel agents" hint="How many agents work at once. 2 is calm on a subscription: every agent shares your plan.">
        <NumberSeg label="Parallel agents" value={s.slots} choices={[1, 2, 3, 4, 6, 8]} onChange={(n) => set({ slots: Math.max(1, n) })} />
      </SettingRow>
      <SettingRow label="Attempts per ticket"
        hint="Best-of-N: this many agents try each ticket in parallel on its first run; the passing change with the smallest diff wins. More attempts, proportionally more usage. 1 = off.">
        <NumberSeg label="Attempts per ticket" value={s.candidates} choices={[1, 2, 3, 4, 5]}
          onChange={(n) => set({ candidates: Math.min(5, Math.max(1, n)) })} />
      </SettingRow>
      <SettingRow label="Run budget (USD)" htmlFor="st-budget" hint="Stop launching new agents once estimated spend crosses this. Empty = no cap.">
        <input id="st-budget" className="input st-num" type="number" min="0" step="0.5" placeholder="No cap"
          value={s.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value.trim() })} />
      </SettingRow>
    </Group>
  );
}
