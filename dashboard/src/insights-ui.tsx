/** Insight surfaces: "why did this fail?" after the fact, and "what will this
 *  cost?" before the fact.
 *
 *  Both read endpoints owned by the analysis tickets (`/api/diagnostics`,
 *  `/api/forecast`, `/api/forecast/actual`). Those endpoints may not be deployed
 *  yet — the client must degrade to a plain "nothing to show" instead of an
 *  error wall, so every fetch here treats failure as absence.
 *
 *  Why the shapes are re-declared as tolerant readers rather than imported:
 *  the server modules that own these payloads (`insights.ts`, `diagnostics.ts`,
 *  `forecast.ts`) are not in this branch, and the field names inside the nested
 *  records (a timeline step, an evidence excerpt) are not pinned by the
 *  contract — only the top-level keys are. Normalising through `unknown` keeps
 *  the UI standing whichever spelling lands, instead of blanking on a rename.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON } from "./api.js";
import { Button, Skeleton } from "./core.js";
import { fmtUsd } from "./model.js";
import {
  Calculator, Clock, FileText, Gauge, Lightbulb, Scale, Stethoscope,
  TrendingDown, TrendingUp, TriangleAlert, Wrench,
} from "./icons.js";
import { Modal, sendControl } from "./widgets.js";

/* ------------------------------ tolerant readers ------------------------------ */

type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Bag : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** First non-empty string among the given keys — absorbs server-side renames. */
const pickStr = (o: Bag, ...keys: string[]): string => {
  for (const k of keys) { const s = str(o[k]); if (s) return s; }
  return "";
};
const pickNum = (o: Bag, ...keys: string[]): number | null => {
  for (const k of keys) { const n = num(o[k]); if (n !== null) return n; }
  return null;
};

/* --------------------------------- diagnosis --------------------------------- */

export interface DiagnosisStep {
  /** Seconds since the first step, or null when the server sent no clock. */
  at: number | null;
  label: string;
  detail: string;
}
export interface DiagnosisEvidence { source: string; excerpt: string }
export interface DiagnosisFix {
  label: string;
  detail: string;
  /** A control-plane op the operator can fire straight from the modal. */
  op: string | null;
  /** A place to send the operator instead — the fix is theirs to make. */
  goto: "ticket" | "settings" | null;
}
export interface Diagnosis {
  category: string;
  headline: string;
  detail: string;
  /** 0…1 when the server quantifies it; null when it only sent a word. */
  confidence: number | null;
  confidenceLabel: string;
  timeline: DiagnosisStep[];
  evidence: DiagnosisEvidence[];
  fixes: DiagnosisFix[];
}

/** Confidence arrives either as a 0–1 (or 0–100) number or as a word. Fold both
 *  into a bar-friendly ratio plus the word the operator actually reads. */
function readConfidence(raw: unknown): { value: number | null; label: string } {
  const n = num(raw);
  if (n !== null) {
    const ratio = n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
    const label = ratio >= 0.75 ? "high confidence" : ratio >= 0.4 ? "moderate confidence" : "low confidence";
    return { value: ratio, label };
  }
  const word = str(raw).toLowerCase();
  if (!word) return { value: null, label: "" };
  const ratio = word.startsWith("high") ? 0.9 : word.startsWith("med") || word.startsWith("mod") ? 0.6 : word.startsWith("low") ? 0.3 : null;
  return { value: ratio, label: `${word} confidence` };
}

/** A recommendation is actionable in one of two ways: it names a control op we
 *  can fire, or it names a screen the human has to go fix something in. */
function readFix(raw: unknown): DiagnosisFix | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    return label ? { label, detail: "", op: null, goto: null } : null;
  }
  const o = bag(raw);
  const label = pickStr(o, "label", "title", "text", "action", "recommendation");
  if (!label) return null;
  const control = bag(o["control"]);
  const op = pickStr(control, "op") || pickStr(o, "op", "controlOp");
  const target = `${pickStr(o, "action", "target", "goto", "kind")} ${label}`.toLowerCase();
  // Only route the human somewhere when no op is offered — an op is the stronger,
  // one-click resolution and must win.
  const goto = op ? null
    : /ticket|scope|rewrite|clarif|instruction/.test(target) ? "ticket" as const
    : /setting|budget|model|effort|config|sandbox|docker|key/.test(target) ? "settings" as const
    : null;
  return { label, detail: pickStr(o, "detail", "why", "rationale", "description"), op: op || null, goto };
}

export function normalizeDiagnosis(raw: unknown): Diagnosis | null {
  // The payload may be the diagnosis itself or wrapped in a one-key envelope.
  const outer = bag(raw);
  const o = bag(outer["diagnosis"] ?? outer["diagnostics"] ?? outer);
  const headline = pickStr(o, "headline", "summary", "title");
  const category = pickStr(o, "category", "kind", "class");
  if (!headline && !category) return null;

  const steps = list(o["timeline"]).map((s) => {
    const b = bag(s);
    return {
      label: pickStr(b, "label", "title", "event", "step"),
      detail: pickStr(b, "detail", "text", "note", "description"),
      atRaw: pickNum(b, "at", "atS", "elapsedS", "offsetS", "seconds"),
      ts: pickNum(b, "ts", "time", "timestamp"),
    };
  }).filter((s) => s.label || s.detail);
  // Absolute timestamps become an elapsed offset — "3m into the run" is what the
  // operator reasons about, not a wall-clock time they have to subtract.
  const firstTs = steps.find((s) => s.ts !== null)?.ts ?? null;
  const timeline: DiagnosisStep[] = steps.map((s) => ({
    label: s.label || "step",
    detail: s.detail,
    at: s.atRaw ?? (s.ts !== null && firstTs !== null ? (s.ts - firstTs) / 1000 : null),
  }));

  const evidence: DiagnosisEvidence[] = list(o["evidence"]).map((e) => {
    if (typeof e === "string") return { source: "", excerpt: e };
    const b = bag(e);
    return { source: pickStr(b, "source", "file", "where", "origin"), excerpt: pickStr(b, "excerpt", "text", "snippet", "line", "content") };
  }).filter((e) => e.excerpt);

  const fixes = list(o["recommendations"] ?? o["fixes"])
    .map((r, i) => ({ fix: readFix(r), rank: pickNum(bag(r), "rank", "order", "priority") ?? i }))
    // Best-first: an explicit rank wins, otherwise the server's own order stands.
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.fix)
    .filter((f): f is DiagnosisFix => f !== null);

  const conf = readConfidence(o["confidence"]);
  return {
    category: category || "unclassified",
    headline: headline || category,
    detail: pickStr(o, "detail", "explanation", "body"),
    confidence: conf.value,
    confidenceLabel: conf.label,
    timeline, evidence, fixes,
  };
}

/** Colour family for a category chip. Reuses the board's status palette so a
 *  failure category reads in the same colour language as the cards. */
export function categoryFam(category: string): string {
  const c = category.toLowerCase();
  if (/budget|cost|spend|limit|rate/.test(c)) return "merging";
  if (/block|ambig|question|unclear|scope/.test(c)) return "blocked";
  if (/verify|test|typecheck|lint|build/.test(c)) return "checking";
  if (/merge|conflict|rebase|git/.test(c)) return "reviewing";
  if (/timeout|stall|hang|crash|tool|infra|sandbox|docker/.test(c)) return "working";
  return "failed";
}

/** "2m 40s in" — the timeline's left gutter. */
function elapsed(at: number | null): string {
  if (at === null) return "—";
  if (at < 60) return `${Math.round(at)}s`;
  const m = Math.floor(at / 60);
  const s = Math.round(at % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function DiagnosticsModal(
  { taskId, title, onClose, onEditTicket, onSettings }:
  { taskId: string; title: string; onClose: () => void;
    onEditTicket: () => void; onSettings: () => void },
): JSX.Element {
  // null = still loading; a Diagnosis or "none" once the server answered.
  const [diag, setDiag] = useState<Diagnosis | "none" | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchJSON<unknown>(`/api/diagnostics?task=${encodeURIComponent(taskId)}`)
      .then((r) => { if (alive) setDiag(normalizeDiagnosis(r) ?? "none"); })
      // A missing analysis and an unreachable analyser look the same to the
      // operator: there is nothing to explain yet.
      .catch(() => { if (alive) setDiag("none"); });
    return () => { alive = false; };
  }, [taskId]);

  const body = (): JSX.Element => {
    if (diag === null) return <Skeleton lines={5} />;
    if (diag === "none") {
      return (
        <p className="hint">
          No diagnosis for {taskId} yet — the analyser had nothing conclusive to say about this
          failure. Its log is still the ground truth.
        </p>
      );
    }
    const fam = categoryFam(diag.category);
    return (
      <div className="diag">
        <div className="diag-head">
          <span className={`diag-cat fam-${fam}`}><Stethoscope size={12} /> {diag.category}</span>
          {diag.confidenceLabel && (
            <span className="diag-conf" title="How sure the analyser is about this reading">
              <Gauge size={12} /> {diag.confidenceLabel}
              {diag.confidence !== null && (
                <span className="diag-conf-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(diag.confidence * 100)}%` }} />
                </span>
              )}
            </span>
          )}
        </div>
        <h4 className="diag-headline">{diag.headline}</h4>
        {diag.detail && <p className="diag-detail">{diag.detail}</p>}

        {diag.timeline.length > 0 && (
          <section className="diag-sec">
            <h5 className="diag-h"><Clock size={13} /> How it got there</h5>
            <ol className="diag-timeline">
              {diag.timeline.map((s, i) => (
                <li key={i} className="diag-step">
                  <span className="diag-at num">{elapsed(s.at)}</span>
                  <span className="diag-step-body">
                    <span className="diag-step-label">{s.label}</span>
                    {s.detail && <span className="diag-step-detail">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {diag.evidence.length > 0 && (
          <section className="diag-sec">
            <h5 className="diag-h"><FileText size={13} /> What it saw</h5>
            <div className="diag-evidence">
              {diag.evidence.map((e, i) => (
                <div key={i} className="diag-ev">
                  {e.source && <div className="diag-ev-src">{e.source}</div>}
                  <pre className="diag-ev-pre">{e.excerpt}</pre>
                </div>
              ))}
            </div>
          </section>
        )}

        {diag.fixes.length > 0 && (
          <section className="diag-sec">
            <h5 className="diag-h"><Lightbulb size={13} /> What to do about it</h5>
            <div className="diag-fixes">
              {diag.fixes.map((f, i) => {
                // The top-ranked fix is the one we want fired — it alone gets the
                // primary weight, the rest stay available but visually quiet.
                const primary = i === 0;
                const label = <><Wrench size={13} /> {f.label}</>;
                const meta = f.detail ? <span className="diag-fix-why">{f.detail}</span> : null;
                if (f.op) {
                  return (
                    <div key={i} className="diag-fix">
                      <Button kind="btn" variant={primary ? "primary" : "ghost"} autoPending
                        onClick={async () => { await sendControl(f.op!, taskId); onClose(); }}>
                        {label}
                      </Button>
                      {meta}
                    </div>
                  );
                }
                if (f.goto) {
                  return (
                    <div key={i} className="diag-fix">
                      <button className={`btn ${primary ? "primary" : "ghost"}`}
                        onClick={() => { if (f.goto === "ticket") onEditTicket(); else onSettings(); }}>
                        {label}
                      </button>
                      {meta}
                    </div>
                  );
                }
                // Advice with nothing to click: still worth reading, so show it as
                // a note rather than dropping it.
                return (
                  <div key={i} className="diag-fix diag-fix-note">
                    <span className="diag-fix-label"><Wrench size={13} /> {f.label}</span>
                    {meta}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    );
  };

  return (
    <Modal title={`Why ${taskId} stopped`} onClose={onClose} wide>
      <p className="diag-sub">{title}</p>
      {body()}
    </Modal>
  );
}

/* --------------------------------- forecast --------------------------------- */

export type ProfileKey = "cheap" | "standard" | "thorough";
const PROFILE_ORDER: ProfileKey[] = ["cheap", "standard", "thorough"];
/** Fallback copy: the server may send its own label/description, but the picker
 *  must still explain the trade-off when it only sends the key. */
const PROFILE_COPY: Record<ProfileKey, { label: string; description: string }> = {
  cheap: { label: "Cheap", description: "Smaller models, low effort — fastest and least expensive, more retries likely." },
  standard: { label: "Standard", description: "The balanced default: capable models at moderate effort." },
  thorough: { label: "Thorough", description: "Best models at high effort — costs the most, fails the least." },
};

export interface ForecastTask {
  id: string; title: string; model: string; effort: string;
  complexity: string; usd: number;
}
export interface Forecast {
  profile: ProfileKey;
  label: string;
  description: string;
  perTask: ForecastTask[];
  totalUsd: number;
  lowUsd: number;
  highUsd: number;
  assumptions: string[];
  /** True when past runs fed the estimate; false when it is pure heuristic. */
  calibrated: boolean;
  /** The server's own payload, kept verbatim so `POST /api/run` can hand the
   *  estimate back unchanged instead of a lossy re-serialisation of our view. */
  raw: unknown;
}

function readForecast(key: string, raw: unknown): Forecast | null {
  const o = bag(raw);
  const profile = (PROFILE_ORDER as string[]).includes(key) ? key as ProfileKey
    : (PROFILE_ORDER as string[]).includes(pickStr(o, "profile")) ? pickStr(o, "profile") as ProfileKey
    : null;
  if (!profile) return null;
  const perTask: ForecastTask[] = list(o["perTask"] ?? o["tasks"]).map((t) => {
    const b = bag(t);
    const cx = b["complexity"];
    return {
      id: pickStr(b, "id", "ticket", "task"),
      title: pickStr(b, "title", "name"),
      model: pickStr(b, "model"),
      effort: pickStr(b, "effort"),
      // Complexity may be a word ("high") or a score — both render as text.
      complexity: typeof cx === "number" ? String(cx) : str(cx),
      usd: pickNum(b, "usd", "costUsd", "estimateUsd", "totalUsd") ?? 0,
    };
  }).filter((t) => t.id);
  const total = pickNum(o, "totalUsd", "total") ?? perTask.reduce((s, t) => s + t.usd, 0);
  const copy = PROFILE_COPY[profile];
  return {
    profile,
    label: pickStr(o, "label", "name") || copy.label,
    description: pickStr(o, "description", "detail", "summary") || copy.description,
    perTask,
    totalUsd: total,
    lowUsd: pickNum(o, "lowUsd", "low", "minUsd") ?? total,
    highUsd: pickNum(o, "highUsd", "high", "maxUsd") ?? total,
    assumptions: list(o["assumptions"]).map(str).filter(Boolean),
    calibrated: o["calibrated"] === true || o["basis"] === "history" || pickStr(o, "basis", "source").toLowerCase().includes("histor"),
    raw,
  };
}

/** The payload may be a list, a by-profile map, or either wrapped in an
 *  envelope. Flatten all of them to the three profiles, in cheap→thorough order. */
export function normalizeForecasts(raw: unknown): Forecast[] {
  const outer = bag(raw);
  const inner = outer["forecasts"] ?? outer["profiles"] ?? raw;
  const found: Forecast[] = Array.isArray(inner)
    ? inner.map((f) => readForecast(pickStr(bag(f), "profile"), f)).filter((f): f is Forecast => f !== null)
    : Object.entries(bag(inner)).map(([k, v]) => readForecast(k, v)).filter((f): f is Forecast => f !== null);
  return PROFILE_ORDER
    .map((p) => found.find((f) => f.profile === p))
    .filter((f): f is Forecast => f !== undefined);
}

/** Fetch the pre-launch estimate. Absence is a normal state, not an error: the
 *  guard keeps working without it. */
export function useForecasts(): { forecasts: Forecast[] | null } {
  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchJSON<unknown>("/api/forecast")
      .then((r) => { if (alive) setForecasts(normalizeForecasts(r)); })
      .catch(() => { if (alive) setForecasts([]); });
    return () => { alive = false; };
  }, []);
  return { forecasts };
}

/** Profile picker + per-ticket breakdown, embedded in the pre-launch guard. */
export function ForecastPanel(
  { forecasts, profile, onProfile, budgetUsd, onSettings }:
  { forecasts: Forecast[]; profile: ProfileKey; onProfile: (p: ProfileKey) => void;
    budgetUsd: number | null; onSettings: () => void },
): JSX.Element | null {
  const chosen = forecasts.find((f) => f.profile === profile) ?? forecasts[0];
  if (!chosen) return null;
  const overBudget = budgetUsd !== null && budgetUsd > 0 && chosen.totalUsd > budgetUsd;
  return (
    <div className="fc">
      <div className="fc-head">
        <h5 className="fc-h"><Calculator size={13} /> What this run should cost</h5>
        <span className="fc-basis" title={chosen.calibrated
          ? "Calibrated on what your past runs actually spent"
          : "No usable history yet — priced from model rates and ticket size"}>
          {chosen.calibrated ? "calibrated on your history" : "heuristic estimate"}
        </span>
      </div>

      <div className="fc-profiles" role="radiogroup" aria-label="Cost profile">
        {forecasts.map((f) => (
          <button key={f.profile} type="button" role="radio" aria-checked={f.profile === profile}
            className={`fc-profile${f.profile === profile ? " on" : ""}`}
            onClick={() => onProfile(f.profile)}>
            <span className="fc-profile-top">
              <span className="fc-profile-name">{f.label}</span>
              <span className="fc-profile-total num">{fmtUsd(f.totalUsd)}</span>
            </span>
            <span className="fc-profile-range num">{fmtUsd(f.lowUsd)} – {fmtUsd(f.highUsd)}</span>
            <span className="fc-profile-desc">{f.description}</span>
          </button>
        ))}
      </div>

      {overBudget && (
        <div className="run-guard-budget warn">
          <TriangleAlert size={14} /> <b>Over your budget cap</b> — {fmtUsd(chosen.totalUsd)} estimated against a
          {" "}{fmtUsd(budgetUsd!)} cap. The run will stop launching agents once the cap is hit, leaving tickets unfinished.
          <button className="btn link" onClick={onSettings}>Raise the cap</button>
        </div>
      )}

      {chosen.perTask.length > 0 && (
        <div className="fc-table-scroll">
          <table className="fc-table">
            <thead>
              <tr>
                <th scope="col">Ticket</th><th scope="col">Model</th><th scope="col">Effort</th>
                <th scope="col">Complexity</th><th scope="col" className="fc-num">Estimate</th>
              </tr>
            </thead>
            <tbody>
              {chosen.perTask.map((t) => (
                <tr key={t.id}>
                  <th scope="row" className="fc-ticket">
                    <span className="fc-ticket-id">{t.id}</span>
                    {t.title && <span className="fc-ticket-title">{t.title}</span>}
                  </th>
                  <td className="fc-mono">{t.model || "—"}</td>
                  <td className="fc-mono">{t.effort || "—"}</td>
                  <td className="fc-mono">{t.complexity || "—"}</td>
                  <td className="fc-num num">{fmtUsd(t.usd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4}>Total</th>
                <td className="fc-num num">{fmtUsd(chosen.totalUsd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {chosen.assumptions.length > 0 && (
        <details className="fc-assume">
          <summary>What this assumes ({chosen.assumptions.length})</summary>
          <ul>{chosen.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </details>
      )}
      <p className="work-hint">An estimate, not a quote — the run stops at your budget cap either way.</p>
    </div>
  );
}

/* ---------------------------- predicted vs actual ---------------------------- */

export interface ActualTask { id: string; predictedUsd: number; actualUsd: number }
export interface Reconciliation {
  predictedUsd: number;
  actualUsd: number;
  deltaPct: number | null;
  profile: string;
  perTask: ActualTask[];
}

export function normalizeReconciliation(raw: unknown): Reconciliation | null {
  const outer = bag(raw);
  const o = bag(outer["actual"] ?? outer["reconciliation"] ?? outer);
  const predicted = pickNum(o, "predictedUsd", "predicted", "forecastUsd");
  const actual = pickNum(o, "actualUsd", "actual", "spentUsd");
  if (predicted === null || actual === null) return null;
  const perTask: ActualTask[] = list(o["perTask"] ?? o["tasks"]).map((t) => {
    const b = bag(t);
    return {
      id: pickStr(b, "id", "ticket", "task"),
      predictedUsd: pickNum(b, "predictedUsd", "predicted", "estimateUsd") ?? 0,
      actualUsd: pickNum(b, "actualUsd", "actual", "costUsd") ?? 0,
    };
  }).filter((t) => t.id);
  return {
    predictedUsd: predicted,
    actualUsd: actual,
    // Recompute rather than trust a sent delta: a 0-dollar prediction has no
    // percentage, and that must render as "—" rather than Infinity.
    deltaPct: predicted > 0 ? ((actual - predicted) / predicted) * 100 : null,
    profile: pickStr(o, "profile"),
    perTask,
  };
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(pct >= 100 || pct <= -100 ? 0 : 1)}%`;
}

/** Predicted-vs-actual reconciliation for the last run. Renders nothing at all
 *  when no forecast was recorded — an empty card would only add noise. */
export function ForecastAccuracy(): JSX.Element | null {
  const [rec, setRec] = useState<Reconciliation | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchJSON<unknown>("/api/forecast/actual")
      .then((r) => { if (alive) setRec(normalizeReconciliation(r)); })
      .catch(() => { /* no forecast recorded — stay invisible */ });
    return () => { alive = false; };
  }, []);
  if (!rec) return null;
  const over = rec.actualUsd > rec.predictedUsd;
  return (
    <section className="fa">
      <div className="fa-head">
        <h4 className="an-h"><Scale size={13} /> Estimate vs reality</h4>
        {rec.profile && <span className="fa-profile">{rec.profile} profile</span>}
      </div>
      <div className="an-tiles">
        <div className="an-tile"><span className="an-fig">{fmtUsd(rec.predictedUsd)}</span><span className="an-cap">predicted</span></div>
        <div className="an-tile"><span className="an-fig">{fmtUsd(rec.actualUsd)}</span><span className="an-cap">actually spent</span></div>
        <div className={`an-tile fa-delta${rec.deltaPct === null ? "" : over ? " fa-over" : " fa-under"}`}>
          <span className="an-fig">
            {rec.deltaPct === null ? "—" : <>{over ? <TrendingUp size={15} /> : <TrendingDown size={15} />} {signed(rec.deltaPct)}</>}
          </span>
          <span className="an-cap">{rec.deltaPct === null ? "no baseline" : over ? "over the estimate" : "under the estimate"}</span>
        </div>
      </div>
      {rec.perTask.length > 0 && (
        <div className="an-table fa-table">
          <div className="an-row an-head"><span>Ticket</span><span>Predicted</span><span>Actual</span><span>Delta</span></div>
          {rec.perTask.map((t) => {
            const d = t.predictedUsd > 0 ? ((t.actualUsd - t.predictedUsd) / t.predictedUsd) * 100 : null;
            return (
              <div key={t.id} className="an-row">
                <span className="an-when">{t.id}</span>
                <span className="an-spend">{fmtUsd(t.predictedUsd)}</span>
                <span className="an-spend">{fmtUsd(t.actualUsd)}</span>
                <span className={`an-spend${d === null ? "" : d > 0 ? " fa-over" : " fa-under"}`}>
                  {d === null ? "—" : signed(d)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
