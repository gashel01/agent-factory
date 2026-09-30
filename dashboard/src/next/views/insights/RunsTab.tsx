/** Insights → Runs: cost, tokens and tickets per run over the chosen period,
 *  the totals, the failure patterns and the run-by-run table. One GET
 *  /api/analytics (one point per run, oldest first), the same source as the
 *  classic "Cost & activity over time" modal. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "../../../api.js";
import { fmtTokens, fmtUsd } from "../../../model.js";
import { Activity } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Empty, Seg, Spinner, Stat } from "../../ui.js";
import { PERIODS, errorPatterns, inPeriod, runLabel, totals } from "./analytics.js";
import type { Period, RunPoint } from "./analytics.js";
import { ErrorPatterns } from "./ErrorPatterns.js";
import { RunBars } from "./RunBars.js";
import { RunTable } from "./RunTable.js";

export function RunsTab(): JSX.Element {
  const { ws } = useWarden();
  const [series, setSeries] = useState<RunPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState<Period>("all");

  useEffect(() => {
    let alive = true;
    setSeries(null); setFailed(false);
    fetchJSON<{ series: RunPoint[] }>("/api/analytics")
      .then((r) => { if (alive) setSeries(r.series); })
      .catch(() => { if (alive) { setFailed(true); setSeries([]); } });
    return () => { alive = false; };
  }, [ws]);

  if (series === null) return <div className="in-loading"><Spinner /></div>;
  if (failed) return <p className="hint" role="alert">Couldn’t load the run history from the server.</p>;
  if (series.length === 0) {
    return <Empty icon={<Activity size={22} />} title="No runs yet">This fills in once you’ve run some work.</Empty>;
  }

  const runs = inPeriod(series, period, Date.now());
  const t = totals(runs);
  const { patterns, total, top } = errorPatterns(runs);
  const periodPicker = <Seg label="Period" value={period} options={PERIODS} onChange={setPeriod} />;

  if (runs.length === 0) {
    return (
      <>
        <div className="row">{periodPicker}</div>
        <Empty icon={<Activity size={22} />} title="No runs in this period">Pick a longer period to see older runs.</Empty>
      </>
    );
  }

  const n = runs.length;
  const latest = runs[n - 1]!;
  return (
    <>
      <div className="row in-toolbar">
        <div className="spacer" />
        {periodPicker}
      </div>
      <div className="in-stats">
        <Stat value={fmtUsd(t.spend)} label={t.costCaption} />
        <Stat value={fmtTokens(t.tokens)} label="Tokens processed · cache included" />
        <Stat value={t.merged} label={`Tickets shipped · ${n} run${n === 1 ? "" : "s"}`} color="var(--st-merged)" />
        <Stat value={total} label="Failures, these runs" color={total ? "var(--st-needs)" : undefined} />
      </div>
      <div className="in-charts">
        <RunBars title="Cost per run" peakWord="most expensive" fmt={fmtUsd}
          summary={`Cost of ${n} runs, highest ${fmtUsd(Math.max(...runs.map((r) => r.spend)))}, latest ${fmtUsd(latest.spend)}.`}
          data={runs.map((r) => ({ label: runLabel(r), segs: [{ name: "Cost", value: r.spend, color: "var(--accent)" }] }))} />
        <RunBars title="Tokens per run" peakWord="busiest" fmt={fmtTokens}
          summary={`Tokens used by ${n} runs, highest ${fmtTokens(Math.max(...runs.map((r) => r.tokens)))}, latest ${fmtTokens(latest.tokens)}.`}
          data={runs.map((r) => ({ label: runLabel(r), segs: [{ name: "Tokens", value: r.tokens, color: "var(--st-working)" }] }))} />
        <RunBars title="Tickets per run" peakWord="most tickets" fmt={(v) => String(v)}
          summary={`Tickets of ${n} runs: ${t.merged} shipped and ${t.needs} needing you in total; latest run shipped ${latest.merged}.`}
          data={runs.map((r) => ({
            label: runLabel(r),
            segs: [
              { name: "shipped", value: r.merged, color: "var(--st-merged)" },
              { name: "need you", value: r.needs, color: "var(--st-needs)" },
            ],
          }))} />
      </div>
      {total > 0 && <ErrorPatterns patterns={patterns} total={total} top={top} runCount={n} />}
      <RunTable runs={runs} />
    </>
  );
}
