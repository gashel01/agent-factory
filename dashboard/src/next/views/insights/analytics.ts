/** Pure helpers behind the Insights page: the per-run series from
 *  GET /api/analytics, filtered to a period and folded into the totals and
 *  failure patterns the page shows. No React, no fetch.
 *
 *  Failure categories come from the server's own diagnosis of every ticket of
 *  every run (diagnostics.ts) and are labelled with its `categoryLabel`. That
 *  diagnosis files a ticket that SHIPPED under "unknown" too ("no failure to
 *  explain"), so "unknown" is left out of the error counts here — counting it
 *  would report every merged ticket as an error. */

import { humanRun } from "../../../board-model.js";
import type { RunPoint } from "../../../board-model.js";
import { categoryLabel } from "../../../diagnostics.js";
import type { DiagnosisCategory } from "../../../diagnostics.js";

export type { RunPoint };
/** A run as a human date + time ("Jul 17 · 20:37"). */
export const runLabel = humanRun;

export type Period = "7d" | "30d" | "all";

export const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All" },
];

const DAY_MS = 86_400_000;

/** Runs inside the period. A run with no timestamp only shows under "All". */
export function inPeriod(runs: RunPoint[], period: Period, now: number): RunPoint[] {
  if (period === "all") return runs;
  const since = now - (period === "7d" ? 7 : 30) * DAY_MS;
  return runs.filter((r) => {
    const t = r.ts ? Date.parse(r.ts) : NaN;
    return Number.isFinite(t) && t >= since;
  });
}

export interface Totals { spend: number; tokens: number; merged: number; needs: number; costCaption: string }

export function totals(runs: RunPoint[]): Totals {
  return {
    spend: runs.reduce((a, r) => a + r.spend, 0),
    tokens: runs.reduce((a, r) => a + r.tokens, 0),
    merged: runs.reduce((a, r) => a + r.merged, 0),
    needs: runs.reduce((a, r) => a + r.needs, 0),
    // On a subscription the dollar figure is an estimate, not a bill.
    costCaption: runs.every((r) => r.mode !== "api") ? "Estimated · not billed on a subscription"
      : runs.every((r) => r.mode === "api") ? "Billed to your API key" : "Estimated · some billed",
  };
}

/** Failure categories of one run, "unknown" excluded (see the header). */
export function runErrors(r: RunPoint): Array<[DiagnosisCategory, number]> {
  return Object.entries(r.error_counts ?? {})
    .filter(([cat, n]) => cat !== "unknown" && n > 0) as Array<[DiagnosisCategory, number]>;
}

export const runErrorTotal = (r: RunPoint): number => runErrors(r).reduce((a, [, n]) => a + n, 0);

export interface Pattern { category: DiagnosisCategory; label: string; count: number; runs: number }

/** Every failure category across the runs, most frequent first, with how many
 *  runs it was the top cause of. */
export function errorPatterns(runs: RunPoint[]): { patterns: Pattern[]; total: number; top: Pattern | null } {
  const counts = new Map<DiagnosisCategory, number>();
  const topOf = new Map<DiagnosisCategory, number>();
  for (const r of runs) {
    const errs = runErrors(r);
    for (const [cat, n] of errs) counts.set(cat, (counts.get(cat) ?? 0) + n);
    const worst = errs.reduce<[DiagnosisCategory | null, number]>((a, [c, n]) => (n > a[1] ? [c, n] : a), [null, 0]);
    if (worst[0]) topOf.set(worst[0], (topOf.get(worst[0]) ?? 0) + 1);
  }
  const patterns = [...counts.entries()]
    .map(([category, count]) => ({ category, label: categoryLabel(category), count, runs: topOf.get(category) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const total = patterns.reduce((a, p) => a + p.count, 0);
  const top = [...patterns].sort((a, b) => b.runs - a.runs || b.count - a.count)[0] ?? null;
  return { patterns, total, top };
}

/** What to do about the most common failure — the classic analytics' advice. */
export function recommendation(cat: DiagnosisCategory): string {
  switch (cat) {
    case "verify_failed": return "Review the verification strategy — failed checks are the main blocker.";
    case "agent_error": return "Check the agent logs for systematic failures — agent errors point at environment or configuration issues.";
    case "merge_conflict": return "Merge conflicts mean concurrent branch changes — sequence dependent tickets more strictly.";
    case "blocked": return "Many tickets wait on you — faster answers cut the blocking.";
    case "timeout": return "Timeouts suggest tickets too big for their time limit — split them or raise the limit.";
    case "rate_limit": return "Rate limits are throttling progress — run fewer tickets at once or spread runs over time.";
    case "budget": return "The budget runs out often — raise the cap or trim what each ticket asks for.";
    default: return "Review the logs of those runs for why tickets end this way.";
  }
}
