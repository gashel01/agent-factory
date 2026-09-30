/** A failed ticket's diagnosis as the server returns it, and its category wording. */

export interface DiagnosisStep { when: string; text: string }
export interface DiagnosisEvidence { source: string; text: string }
/** A recommendation with an `op` is actionable: it maps to an /api/control op. */
export interface DiagnosisFix { label: string; detail: string; op: string; task: string }
export interface Diagnosis {
  category: string; headline: string; detail: string; confidence: number | null;
  timeline: DiagnosisStep[]; evidence: DiagnosisEvidence[]; recommendations: DiagnosisFix[];
}

/** Human wording per diagnosis category. An unlisted one (or "unknown") falls
 *  back to the raw category — "no conclusive cause" is a normal answer here,
 *  not an error state. */
export const DX_CATEGORY: Record<string, string> = {
  verify: "Verification failed",
  test: "Tests failed",
  build: "Build broke",
  timeout: "Ran out of time",
  budget: "Budget reached",
  merge: "Merge conflict",
  blocked: "Needed an answer",
  agent: "The agent gave up",
  infra: "Environment problem",
  scope: "Ticket scope problem",
  unknown: "No conclusive cause",
};
