/** "Start this run?" — the estimate and the guard rails, shown before any
 *  agent launches: pick a profile against its forecast, choose where the work
 *  lands (the base branch, or a fresh integration branch delivered as one PR),
 *  optionally change how many agents work at once, read the warnings, start.
 *
 *  The request is the classic one — POST /api/run with the profile, the
 *  accepted forecast (so the run can be scored against it later) and the
 *  optional base branch; `slots` only when the operator changed it. */

import { useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { fmtUsd, generateConfig } from "../../../model.js";
import type { RunProfile } from "../../../forecast-client.js";
import { Play } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Btn, Pills, Seg, Sheet } from "../../ui.js";
import { ForecastDetail, ProfilePicker } from "./Forecast.js";
import { ModelChoice } from "../projects/ModelChoice.js";
import type { StartingModel } from "../projects/ModelChoice.js";
import { RunGuards } from "./RunGuards.js";
import { useRunGuard } from "./useRunGuard.js";

const integrationBranch = (): string => "integrate/" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

export function RunEstimateSheet({ tickets }: { tickets: number }): JSX.Element {
  const w = useWarden();
  const guard = useRunGuard();
  const [profile, setProfile] = useState<RunProfile>("standard");
  const [deliverNew, setDeliverNew] = useState(false);
  const [branch, setBranch] = useState(integrationBranch);
  const [slots, setSlots] = useState<number | null>(null); // null = the project's setting

  const sel = guard.forecasts?.get(profile) ?? null;
  const done = w.tasks.filter((t) => t.state === "DONE").length;
  const avgCost = done > 0 && w.spent > 0 ? w.spent / done : null;
  const fallback = avgCost !== null ? avgCost * tickets : null;
  // The cap the NEXT run will obey is the one in factory.yaml; the last run's
  // event only stands in until the config answered.
  const cap = guard.settings ? (guard.settings.budgetUsd ? Number(guard.settings.budgetUsd) : null) : w.model.budgetUsd;
  const configSlots = guard.settings?.slots ?? null;
  const base = deliverNew && branch.trim() ? branch.trim() : undefined;
  // A project created before the model became a required choice has none: the
  // CLI would silently pick its own. Ask once, save it, re-estimate with it.
  const needsModel = guard.settings !== null && guard.settings.model === "";
  const [picked, setPicked] = useState<StartingModel>("");
  const pickModel = async (m: StartingModel): Promise<void> => {
    if (!guard.settings || !m) return;
    setPicked(m);
    try {
      await fetchJSON("/api/config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: generateConfig({ ...guard.settings, model: m }) }),
      });
      guard.reload();
    } catch (err) { setPicked(""); toast(String(err), true); }
  };

  const start = async (): Promise<void> => {
    try {
      await postJSON("/api/run", {
        profile, ...(sel ? { forecast: sel.raw } : {}), ...(base ? { base } : {}),
        ...(slots !== null && slots !== configSlots ? { slots } : {}),
      });
      toast(base
        ? `Run starting on ${base} — delivers as one PR, base untouched.`
        : `Run starting on the ${profile} profile — the board follows along.`);
      w.close();
    } catch (err) { toast(String(err), true); }
  };

  const slotChoices = [...new Set([1, 2, 3, 4, ...(configSlots ? [configSlots] : [])])].sort((a, b) => a - b);

  return (
    <Sheet title="Start this run?" onClose={w.close} wide
      headExtra={<p className="hint"><b className="nw-count">{tickets}</b> ticket{tickets === 1 ? "" : "s"} will run (everything not yet merged).</p>}
      footer={
        <>
          <Btn kind="ghost" onClick={w.close}>Cancel</Btn>
          <span className="spacer" />
          <Btn kind="fill" disabled={w.live || needsModel}
            title={w.live ? "A run is already in progress" : needsModel ? "Pick a starting model first" : undefined} onClick={start}>
            <Play size={15} /> Start run
          </Btn>
        </>
      }>
      {needsModel && <ModelChoice value={picked} onChange={(m) => { void pickModel(m); }} />}
      <ProfilePicker value={profile} onChange={setProfile} forecasts={guard.forecasts} />

      {guard.forecasts === null && <div className="skeleton nw-skeleton" aria-label="Loading the estimate" />}
      {sel !== null && <ForecastDetail sel={sel} />}
      {guard.forecastFailed && (
        <p className="hint">
          No estimate this time — the forecast didn’t answer.{" "}
          {fallback !== null
            ? <>Your past runs averaged <b>{fmtUsd(avgCost!)}</b> per merged ticket, so roughly <b>{fmtUsd(fallback)}</b> for this one. A rough guide, not a quote.</>
            : <>You can still start the run.</>}
        </p>
      )}

      <div className="field">
        <span className="field-label">Deliver to</span>
        <Seg label="Deliver to" value={deliverNew ? "branch" : "base"} onChange={(v) => setDeliverNew(v === "branch")}
          options={[{ value: "base", label: "The base branch" }, { value: "branch", label: "A new integration branch" }]} />
        <p className="hint">
          {deliverNew
            ? "Base untouched — the batch lands on its own branch, as one PR you open from here."
            : "Verified tickets merge straight into the base branch."}
        </p>
        {deliverNew && (
          <input className="input mono" aria-label="Integration branch name" placeholder="integrate/…" value={branch}
            onChange={(e) => setBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))} />
        )}
      </div>

      <div className="field">
        <span className="field-label">Parallel agents</span>
        <Pills label="Parallel agents for this run" value={String(slots ?? configSlots ?? "")}
          onChange={(v) => setSlots(Number(v))}
          options={slotChoices.map((n) => ({ value: String(n), label: n === configSlots ? `${n} (your setting)` : String(n) }))} />
      </div>

      <RunGuards guard={guard} budgetUsd={cap} sel={sel} />
    </Sheet>
  );
}
