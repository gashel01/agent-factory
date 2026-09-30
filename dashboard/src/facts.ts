/** Project memory facts: their shape and the hook that loads them. */

import { useCallback, useEffect, useState } from "react";
import { fetchJSON } from "./api.js";

export interface Fact { id: string; text: string; scope: "project" | "global"; ticketId: string | null; createdTs: string; applied?: number }

export function useFacts(ws: string): { facts: Fact[] | null; reload: () => void } {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ facts: Fact[] }>("/api/memory"); setFacts(r.facts); }
    catch { /* keep the previous facts */ }
  }, []);
  useEffect(() => { setFacts(null); void reload(); }, [ws, reload]);
  return { facts, reload: () => void reload() };
}
