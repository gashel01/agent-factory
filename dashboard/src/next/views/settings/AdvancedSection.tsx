/** Settings › Advanced: the knobs with sensible defaults — planning model,
 *  thinking effort, retries, and the notification webhook. */

import type { JSX } from "react";
import { EFFORT_CHOICES } from "../../../model.js";
import type { SectionProps } from "./GeneralSection.js";
import { ChoiceSeg, Group, NumberSeg, SettingRow } from "./parts.js";

const PLAN_CHOICES: Array<[string, string]> = [["", "Same as coders"], ["haiku", "Haiku"], ["sonnet", "Sonnet"]];

export function AdvancedSection({ s, set }: SectionProps): JSX.Element {
  return (
    <Group sub="Sensible defaults — you rarely need to touch these.">
      <SettingRow label="Planning model"
        hint="The ticket-maker explores the repo once and saves a reusable map. A cheaper tier here cuts planning cost. Default matches the coding model.">
        <ChoiceSeg label="Planning model" value={s.planModel} choices={PLAN_CHOICES} onChange={(v) => set({ planModel: v })} />
      </SettingRow>
      <SettingRow label="Thinking effort"
        hint="How hard each agent thinks. Higher digs deeper but is slower and costs more. Default lets the agent decide.">
        <ChoiceSeg label="Thinking effort" value={s.effort} choices={EFFORT_CHOICES} onChange={(v) => set({ effort: v })} />
      </SettingRow>
      <SettingRow label="Retries per ticket"
        hint="How many times a failing ticket is re-attempted before it needs you. Each retry is a full agent run and steps up a model tier.">
        <NumberSeg label="Retries per ticket" value={s.maxRetries} choices={[0, 1, 2, 3]} onChange={(n) => set({ maxRetries: Math.max(0, n) })} />
      </SettingRow>
      <SettingRow label="Notify me" htmlFor="st-webhook" stacked
        hint="Get pinged when a run finishes or a ticket needs you. Paste a Slack, Discord, or any incoming-webhook URL. Empty = off. Fires server-side, so it works with the browser closed.">
        <input id="st-webhook" className="input" type="url" placeholder="https://hooks.slack.com/services/…" value={s.webhookUrl}
          onChange={(e) => set({ webhookUrl: e.target.value })} />
      </SettingRow>
    </Group>
  );
}
