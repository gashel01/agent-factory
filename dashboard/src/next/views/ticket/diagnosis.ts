/** Reading /api/diagnostics for the "Why it failed" tab. The classic modal keeps
 *  its parser private (diagnostics-modal.tsx), so this is a faithful copy of it:
 *  the endpoint wraps the diagnosis as {ok, run, task, diagnosis, summary} and
 *  every field is read defensively (a string step, a 0–1 or 0–100 confidence). */

import type { Diagnosis, DiagnosisEvidence, DiagnosisFix, DiagnosisStep } from "../../../diagnosis-model.js";

const asRec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const asNum = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v)) ? v : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A confidence on the wire may be a 0–1 ratio or an already-scaled percentage. */
export function confidencePct(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(100, Math.round(v <= 1 ? v * 100 : v)));
}

export function parseDiagnosis(raw: unknown): Diagnosis {
  const top = asRec(raw);
  const d = asRec(top["diagnosis"] ?? top);
  return {
    category: asStr(d["category"]) || "unknown",
    headline: asStr(d["headline"]),
    detail: asStr(d["detail"]),
    confidence: asNum(d["confidence"]),
    timeline: asArr(d["timeline"])
      .map((s): DiagnosisStep => {
        if (typeof s === "string") return { when: "", text: s };
        const o = asRec(s);
        return { when: asStr(o["ts"] ?? o["at"]), text: asStr(o["text"] ?? o["label"]) };
      })
      .filter((s) => s.text || s.when),
    evidence: asArr(d["evidence"])
      .map((e): DiagnosisEvidence => {
        if (typeof e === "string") return { source: "", text: e };
        const o = asRec(e);
        return { source: asStr(o["source"] ?? o["file"]), text: asStr(o["text"] ?? o["excerpt"]) };
      })
      .filter((e) => e.text),
    recommendations: asArr(d["recommendations"])
      .map((r): DiagnosisFix => {
        const o = asRec(r);
        return { label: asStr(o["label"]), detail: asStr(o["detail"]), op: asStr(o["op"]), task: asStr(o["task"]) };
      })
      .filter((r) => r.label || r.detail),
  };
}
