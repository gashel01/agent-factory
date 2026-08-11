import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  fetchJSON, postJSON,
} from "./api.js";
import { fmtDuration, fmtUsd, parseSettings } from "./model.js";
import {
  DollarSign, Key, Lock, Play, Timer, TriangleAlert,
} from "./icons.js";
import { Button, Skeleton, toast } from "./core.js";
import { Modal } from "./widgets.js";

export type RunProfile = "cheap" | "standard" | "thorough";

export const RUN_PROFILES: Array<{ key: RunProfile; label: string; blurb: string }> = [
  { key: "cheap", label: "Cheap", blurb: "Smaller model, fewer retries. Good for mechanical tickets." },
  { key: "standard", label: "Standard", blurb: "Your configured setup — the usual balance." },
  { key: "thorough", label: "Thorough", blurb: "More thinking, more retries. For the ones that keep failing." },
];

export interface ForecastTicket { id: string; title: string; usd: number; durationS: number | null }
export interface ProfileForecast {
  profile: RunProfile;
  usd: number; lowUsd: number | null; highUsd: number | null;
  durationS: number | null; basis: string; confidence: number | null;
  tickets: ForecastTicket[];
  raw: unknown;
}

export const FORECAST_BASIS: Record<string, string> = {
  history: "based on your past runs",
  heuristic: "a heuristic guess — no comparable run yet",
  blend: "your past runs blended with a heuristic",
};

export interface DockerStatus {
  engine: boolean; image: boolean; proxy: boolean; ready: boolean;
  detail?: string; building?: boolean; buildOk?: boolean | null; buildLog?: string;
}

const asRec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const asNum = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v)) ? v : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pct(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(100, Math.round(v <= 1 ? v * 100 : v)));
}

export function parseProfileForecast(profile: RunProfile, raw: unknown): ProfileForecast {
  const f = asRec(raw);
  const range = asRec(f["range"]);
  return {
    profile,
    usd: asNum(f["usd"]) ?? asNum(f["totalUsd"]) ?? 0,
    lowUsd: asNum(f["lowUsd"]) ?? asNum(range["low"]),
    highUsd: asNum(f["highUsd"]) ?? asNum(range["high"]),
    durationS: asNum(f["durationS"]) ?? asNum(f["etaS"]),
    basis: asStr(f["basis"]),
    confidence: asNum(f["confidence"]),
    tickets: asArr(f["tickets"] ?? f["perTicket"]).map((t): ForecastTicket => {
      const o = asRec(t);
      return {
        id: asStr(o["id"]), title: asStr(o["title"]),
        usd: asNum(o["usd"]) ?? 0, durationS: asNum(o["durationS"]) ?? asNum(o["etaS"]),
      };
    }),
    raw,
  };
}

export function parseForecasts(raw: unknown): Map<RunProfile, ProfileForecast> {
  const top = asRec(raw);
  const box: unknown = top["forecasts"] ?? top["profiles"] ?? raw;
  const pairs: Array<[string, unknown]> = Array.isArray(box)
    ? box.map((f): [string, unknown] => [asStr(asRec(f)["profile"]), f])
    : Object.entries(asRec(box));
  const out = new Map<RunProfile, ProfileForecast>();
  for (const [key, value] of pairs) {
    const p = RUN_PROFILES.find((x) => x.key === key);
    if (p) out.set(p.key, parseProfileForecast(p.key, value));
  }
  return out;
}

export function RunEstimateModal(
  { tickets, budgetUsd, avgCost, onClose, onSettings }:
  { tickets: number; budgetUsd: number | null; avgCost: number | null;
    onClose: () => void; onSettings: () => void },
): JSX.Element {
  const [profile, setProfile] = useState<RunProfile>("standard");
  const [forecasts, setForecasts] = useState<Map<RunProfile, ProfileForecast> | null>(null);
  const [fcErr, setFcErr] = useState(false);
  const [apiMode, setApiMode] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [dockerReady, setDockerReady] = useState<boolean | null>(null);
  const [project, setProject] = useState<"node" | "python" | "other">("other");
  const [setupCmds, setSetupCmds] = useState("");
  const [deliverNew, setDeliverNew] = useState(false);
  const [branch, setBranch] = useState(
    () => "integrate/" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"),
  );

  useEffect(() => {
    let alive = true;
    void fetchJSON<Record<string, unknown>>("/api/forecast")
      .then((r) => { if (alive) setForecasts(parseForecasts(r)); })
      .catch(() => { if (alive) { setForecasts(new Map()); setFcErr(true); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config")
      .then((r) => {
        const s = parseSettings(r.content);
        setApiMode(s.executionMode === "api");
        setSandbox(s.isolation === "sandbox");
        setProject(s.project);
        setSetupCmds(s.setupCommands);
      })
      .catch(() => { /* offline */ });
  }, []);
  useEffect(() => {
    if (!sandbox) { setDockerReady(null); return; }
    void fetchJSON<DockerStatus>("/api/docker")
      .then((d) => setDockerReady(Boolean(d.engine) && Boolean(d.image)))
      .catch(() => setDockerReady(false));
  }, [sandbox]);

  const sel = forecasts?.get(profile) ?? null;
  const noCap = budgetUsd === null || budgetUsd <= 0;
  const overCap = sel !== null && !noCap && (sel.highUsd ?? sel.usd) > budgetUsd!;
  const conf = pct(sel?.confidence ?? null);
  const fallback = avgCost !== null ? avgCost * tickets : null;
  const needsInstall =
    (project === "node" && !/\b(install|ci)\b/.test(setupCmds)) ||
    (project === "python" && !/uv sync|pip install/.test(setupCmds));

  const base = deliverNew && branch.trim() ? branch.trim() : undefined;
  const start = async (): Promise<void> => {
    try {
      await postJSON("/api/run", { profile, ...(sel ? { forecast: sel.raw } : {}), ...(base ? { base } : {}) });
      toast(base
        ? `Run starting on ${base} — delivers as one PR, base untouched.`
        : `Run starting on the ${profile} profile — remaining tickets replay with the current config.`);
      onClose();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title="Start this run?" onClose={onClose} wide>
      <div className="work-form">
        <div className="run-guard-line">
          <span className="rg-n">{tickets}</span>
          <span>ticket{tickets === 1 ? "" : "s"} will run (everything not yet merged).</span>
        </div>

        <div className="rf-profiles" role="radiogroup" aria-label="Run profile">
          {RUN_PROFILES.map((p) => {
            const f = forecasts?.get(p.key) ?? null;
            return (
              <button key={p.key} role="radio" aria-checked={profile === p.key}
                className={`rf-profile${profile === p.key ? " on" : ""}`} onClick={() => setProfile(p.key)}>
                <span className="rf-profile-name">{p.label}</span>
                <span className="rf-profile-cost tnum">{f ? fmtUsd(f.usd) : "—"}</span>
                <span className="rf-profile-blurb">{p.blurb}</span>
              </button>
            );
          })}
        </div>

        <div className="run-deliver">
          <div className="rd-head">Deliver to</div>
          <label className={`rd-opt${!deliverNew ? " on" : ""}`}>
            <input type="radio" name="deliver" checked={!deliverNew} onChange={() => setDeliverNew(false)} />
            <span><b>The base branch</b> — verified tickets merge straight in.</span>
          </label>
          <label className={`rd-opt${deliverNew ? " on" : ""}`}>
            <input type="radio" name="deliver" checked={deliverNew} onChange={() => setDeliverNew(true)} />
            <span><b>A new integration branch</b> — base untouched, lands as one PR you open from here.</span>
          </label>
          {deliverNew && (
            <input className="rd-branch" value={branch} aria-label="Integration branch name"
              placeholder="integrate/…"
              onChange={(e) => setBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))} />
          )}
        </div>

        {forecasts === null && <Skeleton lines={3} />}

        {sel !== null && (
          <div className="rf-estimate">
            <div className="rf-figures">
              <div className="rf-fig">
                <span className="rf-fig-n tnum">{fmtUsd(sel.usd)}</span>
                <span className="rf-fig-k"><DollarSign size={12} /> estimated total</span>
                {(sel.lowUsd !== null || sel.highUsd !== null) && (
                  <span className="rf-range tnum">
                    {fmtUsd(sel.lowUsd ?? sel.usd)} – {fmtUsd(sel.highUsd ?? sel.usd)}
                  </span>
                )}
              </div>
              {sel.durationS !== null && (
                <div className="rf-fig">
                  <span className="rf-fig-n tnum">{fmtDuration(sel.durationS)}</span>
                  <span className="rf-fig-k"><Timer size={12} /> estimated wall time</span>
                </div>
              )}
            </div>
            <div className="rf-basis">
              {FORECAST_BASIS[sel.basis] ?? "estimate"}
              {conf !== null && <> · <span className="tnum">{conf}%</span> confidence</>}
            </div>
            {sel.tickets.length > 0 && (
              <ul className="rf-breakdown">
                {sel.tickets.map((t, i) => (
                  <li key={t.id || i}>
                    <span className="kcard-id">{t.id}</span>
                    <span className="rf-bd-title">{t.title}</span>
                    {t.durationS !== null && <span className="rf-bd-dur tnum">{fmtDuration(t.durationS)}</span>}
                    <span className="rf-bd-cost tnum">{fmtUsd(t.usd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {fcErr && (
          <p className="work-hint">
            No estimate this time — the forecast didn't answer. {fallback !== null
              ? <>Your past runs averaged <b>{fmtUsd(avgCost!)}</b> per merged ticket, so roughly <b>{fmtUsd(fallback)}</b> for this one. A rough guide, not a quote.</>
              : <>You can still start the run.</>}
          </p>
        )}

        {needsInstall && (
          <div className="run-guard-budget warn">
            <TriangleAlert size={14} /> <b>No dependency install in setup</b> — agents work in fresh worktrees, so verify may fail with "command not found". Add <code>{project === "python" ? "uv sync" : "npm install"}</code> to setup.
            <button className="btn link" onClick={onSettings}>Fix in Settings</button>
          </div>
        )}
        {apiMode && (
          <div className="run-guard-budget warn">
            <Key size={14} /> <b>API mode</b> — this run bills real dollars to your <code>ANTHROPIC_API_KEY</code>.
            <button className="btn link" onClick={onSettings}>Switch to Subscription</button>
          </div>
        )}
        {sandbox && (
          dockerReady === false ? (
            <div className="run-guard-budget warn">
              <Lock size={14} /> <b>Sandbox selected, but Docker isn't ready</b> — the run will fail until the engine is up and the image is built.
              <button className="btn link" onClick={onSettings}>Fix in Settings</button>
            </div>
          ) : (
            <div className="run-guard-budget">
              <Lock size={14} /> <b>Sandbox mode</b> — agents run confined: only their worktree is visible, egress limited to Anthropic.
            </div>
          )
        )}

        <div className={`run-guard-budget${noCap || overCap ? " warn" : ""}`}>
          {noCap
            ? <>No budget cap — this run can spend without a limit. <button className="btn link" onClick={onSettings}>Set a cap</button></>
            : overCap
              ? <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b> — the high end of this estimate goes past it, so the run may stop before every ticket is done. <button className="btn link" onClick={onSettings}>Raise it</button></>
              : <>Budget cap in force: <b>{fmtUsd(budgetUsd!)}</b>. The run stops launching new agents once it's reached.</>}
        </div>
      </div>
      <div className="panel-foot spread modal-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button kind="btn" variant="primary" autoPending onClick={start}><Play size={14} /> Start run</Button>
      </div>
    </Modal>
  );
}
