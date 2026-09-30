/** Memory's data: the lessons (/api/memory — this project's plus the global
 *  ones, each with how often it was fed to an agent) and the writes on them.
 *  Same endpoints and bodies as the classic FactEditor; kept local so the new
 *  bundle doesn't pull the classic screens in. */

import { useCallback, useEffect, useState } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import type { Fact } from "../../../facts.js";

export type { Fact };
export type Scope = Fact["scope"];

export function useFacts(ws: string): { facts: Fact[] | null; reload: () => void } {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ facts: Fact[] }>("/api/memory"); setFacts(r.facts); }
    catch { /* keep the previous facts */ }
  }, []);
  useEffect(() => { setFacts(null); void reload(); }, [ws, reload]);
  return { facts, reload: () => void reload() };
}

export interface LessonBody { text: string; scope: Scope; ticketId: string | null }

/** Create (no id) or update a lesson. A scope change moves it server-side. */
export async function saveLesson(id: string | null, body: LessonBody): Promise<void> {
  if (id === null) await postJSON("/api/memory", body);
  else await fetchJSON(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

export async function deleteLesson(id: string): Promise<void> {
  await fetchJSON(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
}
