/** The warnings shown before a run starts, each with the one-click way out:
 *  no dependency install, API billing, a sandbox whose Docker isn't ready, and
 *  the budget cap (none, in force, or likely to be hit by this estimate). */

import type { JSX, ReactNode } from "react";
import { fmtUsd } from "../../../model.js";
import type { ProfileForecast } from "../../../forecast-client.js";
import { DollarSign, Key, Lock, TriangleAlert } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Btn } from "../../ui.js";
import type { RunGuard } from "./useRunGuard.js";

function Notice({ warn, icon, children, fix, section }: {
  warn?: boolean; icon: ReactNode; children: ReactNode; fix?: string; section?: string;
}): JSX.Element {
  const w = useWarden();
  return (
    <div className={`nw-notice${warn ? " warn" : ""}`}>
      <span className="nw-notice-icon" aria-hidden="true">{icon}</span>
      <p className="nw-notice-text">{children}</p>
      {fix && <Btn small kind="ghost" onClick={() => { w.close(); w.go("settings", section ?? "general"); }}>{fix}</Btn>}
    </div>
  );
}

export function RunGuards({ guard, budgetUsd, sel }: {
  guard: RunGuard; budgetUsd: number | null; sel: ProfileForecast | null;
}): JSX.Element {
  const s = guard.settings;
  // Only when the project really has third-party dependencies (its manifests or
  // the tickets' checks say so) and setup doesn't already install them.
  const need = guard.setupNeed;
  const needsInstall = s !== null && need !== null && need.needed
    && !/\b(install|ci|sync)\b/.test(s.setupCommands);
  const noCap = budgetUsd === null || budgetUsd <= 0;
  const overCap = sel !== null && !noCap && (sel.highUsd ?? sel.usd) > budgetUsd!;

  return (
    <div className="stack nw-notices">
      {needsInstall && (
        <Notice warn icon={<TriangleAlert size={16} />} fix="Fix in Settings" section="project">
          <b>No dependency install in setup</b> — agents work in fresh worktrees, so checks may fail with “command not found”.
          Add <span className="mono">{need!.command}</span> to setup.
        </Notice>
      )}
      {s?.executionMode === "api" && (
        <Notice warn icon={<Key size={16} />} fix="Switch to Subscription" section="safety">
          <b>API mode</b> — this run bills real dollars to your <span className="mono">ANTHROPIC_API_KEY</span>.
        </Notice>
      )}
      {s?.isolation === "sandbox" && (guard.dockerReady === false ? (
        <Notice warn icon={<Lock size={16} />} fix="Fix in Settings" section="safety">
          <b>Sandbox selected, but Docker isn’t ready</b> — the run will fail until the engine is up and the image is built.
        </Notice>
      ) : (
        <Notice icon={<Lock size={16} />}>
          <b>Sandbox mode</b> — agents run confined: only their worktree is visible, egress limited to Anthropic.
        </Notice>
      ))}
      {noCap ? (
        <Notice warn icon={<DollarSign size={16} />} fix="Set a cap">No budget cap — this run can spend without a limit.</Notice>
      ) : overCap ? (
        <Notice warn icon={<DollarSign size={16} />} fix="Raise it">
          Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b> — the high end of this estimate goes past it, so the run may stop before every ticket is done.
        </Notice>
      ) : (
        <Notice icon={<DollarSign size={16} />}>
          Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b>. The run stops launching new agents once it’s reached.
        </Notice>
      )}
    </div>
  );
}
