/** The run's cost forecast: one card per profile (cheap / standard /
 *  thorough) to pick from, then the chosen profile's total, range, wall time,
 *  basis and per-ticket breakdown — exactly what /api/forecast answered. */

import type { JSX } from "react";
import { fmtDuration, fmtUsd } from "../../../model.js";
import { FORECAST_BASIS, RUN_PROFILES } from "../../../forecast-client.js";
import type { ProfileForecast, RunProfile } from "../../../forecast-client.js";
import { DollarSign, Timer } from "../../icons.js";

/** Confidence as a 0–100 percentage, whether the server sent 0–1 or 0–100. */
function pct(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(100, Math.round(v <= 1 ? v * 100 : v)));
}

export function ProfilePicker({ value, onChange, forecasts }: {
  value: RunProfile; onChange: (p: RunProfile) => void; forecasts: Map<RunProfile, ProfileForecast> | null;
}): JSX.Element {
  return (
    <div className="nw-profiles" role="radiogroup" aria-label="Run profile">
      {RUN_PROFILES.map((p) => {
        const f = forecasts?.get(p.key) ?? null;
        return (
          <button key={p.key} type="button" role="radio" aria-checked={value === p.key} className="nw-profile"
            onClick={() => onChange(p.key)}>
            <span className="nw-profile-name">{p.label}</span>
            <span className="nw-profile-cost">{f ? fmtUsd(f.usd) : "—"}</span>
            <span className="hint">{p.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ForecastDetail({ sel }: { sel: ProfileForecast }): JSX.Element {
  const conf = pct(sel.confidence);
  return (
    <section className="card tight nw-forecast">
      <div className="nw-figures">
        <div className="stack nw-figure">
          <span className="nw-figure-n">{fmtUsd(sel.usd)}</span>
          <span className="hint row nw-figure-k"><DollarSign size={13} aria-hidden="true" /> estimated total</span>
          {(sel.lowUsd !== null || sel.highUsd !== null) && (
            <span className="mono faint">{fmtUsd(sel.lowUsd ?? sel.usd)} – {fmtUsd(sel.highUsd ?? sel.usd)}</span>
          )}
        </div>
        {sel.durationS !== null && (
          <div className="stack nw-figure">
            <span className="nw-figure-n">{fmtDuration(sel.durationS)}</span>
            <span className="hint row nw-figure-k"><Timer size={13} aria-hidden="true" /> estimated wall time</span>
          </div>
        )}
      </div>
      <p className="hint">
        {FORECAST_BASIS[sel.basis] ?? "estimate"}
        {conf !== null && <> · {conf}% confidence</>}
      </p>
      {sel.tickets.length > 0 && (
        <ul className="nw-breakdown">
          {sel.tickets.map((t, i) => (
            <li key={t.id || i} className="nw-breakdown-row">
              <span className="mono faint">{t.id}</span>
              <span className="nw-breakdown-title">{t.title}</span>
              {t.durationS !== null && <span className="mono faint">{fmtDuration(t.durationS)}</span>}
              <span className="mono">{fmtUsd(t.usd)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
