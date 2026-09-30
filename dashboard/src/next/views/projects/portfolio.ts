/** The Projects page's data: /api/portfolio (one entry per workspace with its
 *  board-accurate counts, spend and budget), polled so a ticket finishing in
 *  another project shows up. Same endpoint and cadence as the classic screen;
 *  kept local so the new bundle doesn't pull the classic screens in. */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../../../api.js";
import { usePolling } from "../../../core.js";
import type { PortfolioProject } from "../../../api-shapes.js";

export type { PortfolioProject };

/** Portfolio refresh cadence (a ticket finishing in another project shows up). */
const PORTFOLIO_POLL_MS = 4000;

export function usePortfolio(): { projects: PortfolioProject[] | null; reload: () => void } {
  const [projects, setProjects] = useState<PortfolioProject[] | null>(null);
  const mounted = useRef(true);
  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await fetchJSON<{ projects: PortfolioProject[] }>("/api/portfolio");
      if (mounted.current) setProjects(r.projects);
    } catch { /* keep the previous projects */ }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  usePolling(reload, PORTFOLIO_POLL_MS, [reload]);
  return { projects, reload: () => void reload() };
}

/** One status per project, most urgent first (same order as the classic card). */
export function projectStatus(c: PortfolioProject["counts"]): { label: string; color: string } {
  if (c.needs > 0) return { label: "Needs you", color: "var(--st-needs)" };
  if (c.working > 0) return { label: "Working", color: "var(--st-working)" };
  if (c.queued > 0) return { label: "Up next", color: "var(--st-queued)" };
  if (c.merged > 0) return { label: "Up to date", color: "var(--st-merged)" };
  return { label: "No run yet", color: "var(--st-queued)" };
}

/** Last path segment of a folder (Windows or POSIX separators). */
export function baseName(path: string): string {
  return path.split(/[\/]/).filter(Boolean).pop() ?? path;
}
