/** Settings › Execution & safety: how agents are billed, how they're confined,
 *  how their work is delivered, and whether they may reach the web. The rail's
 *  "How this project runs" popover deep-links here. */

import type { JSX } from "react";
import { InfinityIcon, Key } from "../../icons.js";
import { Seg, Switch } from "../../ui.js";
import type { SectionProps } from "./GeneralSection.js";
import { Group, SettingRow } from "./parts.js";
import { SandboxControl } from "./SandboxControl.js";

export function SafetySection({ s, set }: SectionProps): JSX.Element {
  return (
    <Group>
      <SettingRow label="Execution mode"
        hint="Subscription draws from your Claude plan (no real charge; the cost shown is an estimate). API uses the key in your environment and bills real dollars. The key is never stored — only whether to pass it to the agent.">
        <Seg label="Execution mode" value={s.executionMode} onChange={(v) => set({ executionMode: v })} options={[
          { value: "subscription", label: <span className="row st-seg-icon"><InfinityIcon size={14} /> Subscription</span> },
          { value: "api", label: <span className="row st-seg-icon"><Key size={14} /> API</span> },
        ]} />
      </SettingRow>
      <SettingRow stacked label="Sandboxing"
        hint="Direct runs agents as normal processes — fast, full access to your machine (the default). Sandbox boxes each agent in a hardened container: only its own copy of the repo is visible, network limited to Anthropic, privileges dropped. For untrusted work or a client demo.">
        <SandboxControl value={s.isolation} onChange={(v) => set({ isolation: v })} />
      </SettingRow>
      <SettingRow label="Delivery: a pull request per ticket"
        hint="Off (default): each verified ticket merges straight into the base branch — one integrated result lands locally. On: each verified ticket is pushed to its own branch and opened as a GitHub PR — your base branch does not move until you merge them, and a batch becomes several PRs to review. Needs a connected GitHub repo.">
        <Switch label="A pull request per ticket" checked={s.prNative} onChange={(v) => set({ prNative: v })} />
      </SettingRow>
      <SettingRow label="Internet access" hint="Agents may search and read the web. Needed for research; adds exposure to web content.">
        <Switch label="Internet access" checked={s.internet} onChange={(v) => set({ internet: v })} />
      </SettingRow>
    </Group>
  );
}
