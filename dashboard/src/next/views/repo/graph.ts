/** Lane layout for the branch timeline. The algorithm is the classic
 *  repo-modal computeGraph, kept line-for-line; the only change is that lanes
 *  are coloured with the new interface's tokens instead of fixed hex values, so
 *  the railroad follows the light and dark themes. */

import type { Commit } from "../../../repo-model.js";

export const LANE_W = 15;
export const ROW_H = 44;
export const DOT_R = 4.5;

const LANE_COLORS = [
  "var(--st-working)", "var(--st-merged)", "var(--st-review)", "var(--st-needs)",
  "var(--st-checking)", "var(--st-info)", "var(--accent)", "var(--st-queued)",
];
const laneColor = (i: number): string => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]!;

export interface GraphSeg { x1: number; y1: number; x2: number; y2: number; color: string }
export interface GraphRow { commit: Commit; col: number; lanes: number; segs: GraphSeg[]; dotColor: string }

/** Assign each commit a stable lane and pre-compute the connectors row by row.
 *  Commits arrive newest-first in topo order, so a lane "holds" a hash from the
 *  child that opened it until its parent is reached. */
export function computeGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const cx = (col: number): number => col * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const incoming = lanes.slice();
    let col = incoming.findIndex((h) => h === commit.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) { col = lanes.length; lanes.push(null); }
    }
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.hash) lanes[i] = null;

    const parentCols: number[] = [];
    commit.parents.forEach((ph, p) => {
      let pc: number;
      if (p === 0) { pc = col; }
      else { pc = lanes.indexOf(ph); if (pc === -1) { pc = lanes.indexOf(null); if (pc === -1) { pc = lanes.length; lanes.push(null); } } }
      lanes[pc] = ph;
      parentCols.push(pc);
    });
    if (commit.parents.length === 0) lanes[col] = null;

    const outgoing = lanes.slice();
    const segs: GraphSeg[] = [];
    incoming.forEach((h, L) => {
      if (h == null) return;
      if (h === commit.hash) segs.push({ x1: cx(L), y1: 0, x2: cx(col), y2: mid, color: laneColor(L) });
      else segs.push({ x1: cx(L), y1: 0, x2: cx(L), y2: mid, color: laneColor(L) });
    });
    outgoing.forEach((h, L) => {
      if (h == null) return;
      if (parentCols.includes(L)) segs.push({ x1: cx(col), y1: mid, x2: cx(L), y2: ROW_H, color: laneColor(L) });
      else segs.push({ x1: cx(L), y1: mid, x2: cx(L), y2: ROW_H, color: laneColor(L) });
    });

    rows.push({ commit, col, lanes: Math.max(incoming.length, outgoing.length, col + 1, 1), segs, dotColor: laneColor(col) });
  }
  return rows;
}

/** Clean a git ref decoration into a short label + kind; remote duplicates are hidden. */
export function refLabel(ref: string): { text: string; kind: "head" | "tag" | "branch" } | null {
  if (ref === "HEAD") return { text: "HEAD", kind: "head" };
  if (ref.startsWith("HEAD -> ")) return { text: ref.slice(8), kind: "head" };
  if (ref.startsWith("tag: ")) return { text: ref.slice(5), kind: "tag" };
  if (ref.startsWith("origin/") || ref.startsWith("remotes/")) return null;
  return { text: ref, kind: "branch" };
}
