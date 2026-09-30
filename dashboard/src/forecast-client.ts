/** Client side of /api/forecast: the run profiles, and parsing the server's
 *  per-profile estimates into typed values. */

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

const asRec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const asNum = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v)) ? v : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
