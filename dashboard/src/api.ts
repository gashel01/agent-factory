/** Network layer: workspace-scoped fetch helpers. No React, no DOM. */

let currentWs = "";

// Auth token for mutating endpoints. Taken from ?token=… on first load (then
// stored), so the operator opens the tokened URL once. GETs work without it.
let token = "";
export function initToken(): void {
  try {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) { token = fromUrl; localStorage.setItem("factory.token", fromUrl); }
    else token = localStorage.getItem("factory.token") ?? "";
  } catch { token = ""; }
}
export function getToken(): string {
  return token;
}

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

/** Append ?ws= (active workspace) and ?token= (auth) to a path. */
export function api(path: string): string {
  const params: string[] = [];
  if (currentWs) params.push("ws=" + encodeURIComponent(currentWs));
  if (token) params.push("token=" + encodeURIComponent(token));
  if (!params.length) return path;
  return path + (path.includes("?") ? "&" : "?") + params.join("&");
}

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Like fetchJSON but scoped to an explicit workspace, not the active one. */
export async function scopedJSON<T>(path: string, ws: string, init?: RequestInit): Promise<T> {
  const q = "ws=" + encodeURIComponent(ws) + (token ? "&token=" + encodeURIComponent(token) : "");
  const full = path + (path.includes("?") ? "&" : "?") + q;
  const res = await fetch(full, init);
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
