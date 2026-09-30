/** Everything the pre-run sheet needs to know before launching: the cost
 *  forecast per profile (/api/forecast), and the project settings that change
 *  what a run means — API billing, sandbox readiness, a missing dependency
 *  install, the budget cap, the configured slots. Same sources as the classic
 *  RunEstimateModal. */

import { useEffect, useState } from "react";
import { fetchJSON } from "../../../api.js";
import { parseSettings } from "../../../model.js";
import type { Settings } from "../../../model.js";
import { parseForecasts } from "../../../forecast-client.js";
import type { ProfileForecast, RunProfile } from "../../../forecast-client.js";
import type { DockerStatus } from "../../../api-shapes.js";
import { useWarden } from "../../data.js";

export interface RunGuard {
  /** null while loading; empty when the forecast didn't answer. */
  forecasts: Map<RunProfile, ProfileForecast> | null;
  forecastFailed: boolean;
  /** null until factory.yaml answered. */
  settings: Settings | null;
  /** null = not in sandbox mode / still checking. */
  dockerReady: boolean | null;
  /** What the project really needs installed in each fresh worktree (from its
   *  manifests and the tickets' checks), or null while loading. */
  setupNeed: { needed: boolean; command: string | null } | null;
  /** Re-read the forecast and the config (after the sheet changed factory.yaml). */
  reload: () => void;
}

export function useRunGuard(): RunGuard {
  const w = useWarden();
  const [forecasts, setForecasts] = useState<Map<RunProfile, ProfileForecast> | null>(null);
  const [forecastFailed, setForecastFailed] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dockerReady, setDockerReady] = useState<boolean | null>(null);
  const [setupNeed, setSetupNeed] = useState<RunGuard["setupNeed"]>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchJSON<Record<string, unknown>>("/api/forecast")
      .then((r) => {
        if (!alive) return;
        setForecasts(parseForecasts(r));
        const s = r.setup as { needed?: unknown; command?: unknown } | undefined;
        setSetupNeed(s ? { needed: s.needed === true, command: typeof s.command === "string" ? s.command : null } : null);
      })
      .catch(() => { if (alive) { setForecasts(new Map()); setForecastFailed(true); } });
    fetchJSON<{ content: string }>("/api/config")
      .then((r) => { if (alive) setSettings(parseSettings(r.content)); })
      .catch(() => { /* offline: the guards that need it stay quiet */ });
    return () => { alive = false; };
  }, [w.ws, nonce]);

  const sandbox = settings?.isolation === "sandbox";
  useEffect(() => {
    if (!sandbox) { setDockerReady(null); return; }
    let alive = true;
    fetchJSON<DockerStatus>("/api/docker")
      .then((d) => { if (alive) setDockerReady(Boolean(d.engine) && Boolean(d.image)); })
      .catch(() => { if (alive) setDockerReady(false); });
    return () => { alive = false; };
  }, [sandbox]);

  return { forecasts, forecastFailed, settings, dockerReady, setupNeed, reload: () => setNonce((n) => n + 1) };
}
