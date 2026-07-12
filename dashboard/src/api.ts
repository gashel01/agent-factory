/** Network layer: workspace-scoped fetch helpers. No React, no DOM. */

let currentWs = "";
export function getWs(): string {
  return currentWs;
}
export function setWs(name: string): void {
  currentWs = name;
  try {
    localStorage.setItem("factory.ws", name);
  } catch {
    /* private mode */
  }
}
export function initWs(): void {
  try {
    currentWs = localStorage.getItem("factory.ws") ?? "";
  } catch {
    currentWs = "";
  }
}

/** Append ?ws= to a path so every call is scoped to the active workspace. */
export function api(path: string): string {
  if (!currentWs) return path;
  return path + (path.includes("?") ? "&" : "?") + "ws=" + encodeURIComponent(currentWs);
}

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function postJSON<T = unknown>(path: string, body: unknown): Promise<T> {
  return fetchJSON<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getText(path: string): Promise<string | null> {
  const res = await fetch(api(path));
  if (!res.ok) return null;
  return res.text();
}

/* ---- repo helpers (path-scoped, not ws-scoped) ---- */

export function repoPath(): string {
  try {
    return (localStorage.getItem("factory.repo") ?? "").trim();
  } catch {
    return "";
  }
}
export function setRepoPath(p: string): void {
  try {
    localStorage.setItem("factory.repo", p);
  } catch {
    /* ignore */
  }
}
export function repoGet<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ repo: repoPath(), ...params });
  return fetchJSON<T>(`/api/repo/${endpoint}?${qs}`);
}
