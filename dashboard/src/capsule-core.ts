/** Pure capsule helpers — no Node/DOM deps, so they're unit-testable in isolation.
 *  Parsing agent output, and diffing capsules for the conversational-edit review. */

import type { Capsule, CapsuleConsent } from "./types.js";

/** Pull the capsule object out of an agent reply (a ```json block, else the
 *  outermost {...}); return it only if it minimally matches the schema. */
export function extractCapsule(text: string): Capsule | null {
  const candidates: string[] = [];
  const fence = /```json\s*([\s\S]*?)```/i.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as Capsule;
      if (o && (o as { version?: unknown }).version && Array.isArray((o as { actions?: unknown }).actions)) return o;
    } catch { /* try next candidate */ }
  }
  return null;
}

/** Pull an array of consent objects from an agent reply. */
export function extractConsents(text: string): CapsuleConsent[] | null {
  const candidates: string[] = [];
  const fence = /```json\s*([\s\S]*?)```/i.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("["), last = text.lastIndexOf("]");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const arr = JSON.parse(c) as CapsuleConsent[];
      if (Array.isArray(arr) && arr.every((x) => x && typeof x.id === "string" && x.facts)) return arr;
    } catch { /* try next */ }
  }
  return null;
}

/** A behavioral judge's structured verdict, parsed from the agent reply. */
export function parseVerdict(text: string): { verdict: "pass" | "fail"; confidence: number; reasons: string[] } | null {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text)?.[1];
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  for (const c of [fence, first >= 0 && last > first ? text.slice(first, last + 1) : null]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c) as { verdict?: string; confidence?: number; reasons?: string[] };
      if (o.verdict === "pass" || o.verdict === "fail") {
        return { verdict: o.verdict, confidence: typeof o.confidence === "number" ? o.confidence : 0.5, reasons: Array.isArray(o.reasons) ? o.reasons.map(String) : [] };
      }
    } catch { /* next */ }
  }
  return null;
}

export type DiffLine = { t: "ctx" | "add" | "del"; s: string };

/** Compact LCS line diff (capsules are small — O(n*m) is fine). */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "ctx", s: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ t: "del", s: a[i]! }); i++; }
    else { out.push({ t: "add", s: b[j]! }); j++; }
  }
  while (i < n) out.push({ t: "del", s: a[i++]! });
  while (j < m) out.push({ t: "add", s: b[j++]! });
  return out;
}

/** Diff two capsules as pretty-printed JSON. */
export function capsuleDiff(oldC: Capsule | null, newC: Capsule): DiffLine[] {
  const a = oldC ? JSON.stringify(oldC, null, 2).split("\n") : [];
  const b = JSON.stringify(newC, null, 2).split("\n");
  return lineDiff(a, b);
}
