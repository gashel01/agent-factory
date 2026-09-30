/** Settings › Trust & checks: what has to be true before a change lands —
 *  a passing check, the AI reviewer, your own approval, the integration suite. */

import type { JSX } from "react";
import { Switch } from "../../ui.js";
import type { SectionProps } from "./GeneralSection.js";
import { ChoiceSeg, Group, SettingRow } from "./parts.js";

const ON_FAILURE: Array<[string, string]> = [["hold", "Hold for me"], ["reject", "Send back"], ["approve", "Merge anyway"]];

export function TrustSection({ s, set }: SectionProps): JSX.Element {
  return (
    <>
      <Group>
        <SettingRow label="Require a passing check"
          hint="A ticket only counts as done when a test or build command proves it. Off = a ticket with no command is accepted on its diff alone. A single ticket can still opt out with skip_verify.">
          <Switch label="Require a passing check" checked={s.requireVerify} onChange={(v) => set({ requireVerify: v })} />
        </SettingRow>
        <SettingRow label="Default checks" htmlFor="st-verify"
          hint="Commands every ticket must pass when it doesn't list its own (e.g. your test suite). Comma-separated.">
          <input id="st-verify" className="input mono st-text" placeholder="npm test" value={s.verifyCommands}
            onChange={(e) => set({ verifyCommands: e.target.value })} />
        </SettingRow>
        <SettingRow label="Integration check" htmlFor="st-integration"
          hint="After every ticket merges, run this suite once to prove the merged changes still hold together. Empty = off. Comma-separated.">
          <input id="st-integration" className="input mono st-text" placeholder="npm run build, npm test" value={s.integrationCommands}
            onChange={(e) => set({ integrationCommands: e.target.value })} />
        </SettingRow>
      </Group>
      <Group>
        <SettingRow label="Code reviewer" hint="A second AI double-checks every change before merge: scope, gamed tests, obvious bugs.">
          <Switch label="Code reviewer" checked={s.reviewer} onChange={(v) => set({ reviewer: v })} />
        </SettingRow>
        {s.reviewer && (
          <SettingRow label="If the reviewer can’t decide"
            hint="A review that times out, crashes or gives no verdict is retried once, then: Hold parks the ticket in “To review” for you (safest), Send back returns it to the agent, Merge anyway trusts the checks alone.">
            <ChoiceSeg label="If the reviewer can’t decide" value={s.reviewOnFailure} choices={ON_FAILURE}
              onChange={(v) => set({ reviewOnFailure: v as typeof s.reviewOnFailure })} />
          </SettingRow>
        )}
        <SettingRow label="Review before merge" hint="Approve every change yourself. Finished work waits in “To review” instead of merging on its own.">
          <Switch label="Review before merge" checked={s.manualApproval} onChange={(v) => set({ manualApproval: v })} />
        </SettingRow>
      </Group>
    </>
  );
}
