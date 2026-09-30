/** Network layer: workspace-scoped fetch helpers. No React, no DOM. */

let currentWs = "";

// Auth token. Taken from ?token=… on first load (then stored), so the operator
// opens the tokened URL once. Loopback GETs work without it; LAN mode needs it on
// every /api call.
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

/** Header carrying the auth token on fetch() calls (kept out of the URL/logs). */
const TOKEN_HEADER = "x-factory-token";
/** A request that hasn't answered by then is reported as timed out, not left hanging. */
const FETCH_TIMEOUT_MS = 30_000;
/** How much of a non-JSON body to quote in the error (an HTML error page, a proxy banner…). */
const ERROR_SNIPPET_CHARS = 120;

function withQuery(path: string, params: string[]): string {
  if (!params.length) return path;
  return path + (path.includes("?") ? "&" : "?") + params.join("&");
}
function wsParam(ws: string): string[] {
  return ws ? ["ws=" + encodeURIComponent(ws)] : [];
}

/**
 * Append ?ws= (active workspace) and ?token= (auth) to a path. Only for URLs the
 * browser loads itself (EventSource, <img src>, window.open) — they can't carry a
 * header. fetch() goes through the helpers below, which send the token as a header.
 */
export function api(path: string): string {
  const params = wsParam(currentWs);
  if (token) params.push("token=" + encodeURIComponent(token));
  return withQuery(path, params);
}

/** fetch() with the auth header merged in and a timeout (combined with any caller signal). */
async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set(TOKEN_HEADER, token);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, headers, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("request timed out");
    throw e;
  }
}

/** Parse a JSON response, turning HTML error pages / bad JSON / `{error}` into readable Errors. */
async function readJSON<T>(res: Response): Promise<T> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    const text = (await res.text().catch(() => "")).trim().slice(0, ERROR_SNIPPET_CHARS);
    throw new Error(`HTTP ${res.status}${text ? " — " + text : ""}`);
  }
  let data: T & { ok?: boolean; error?: string };
  try {
    data = (await res.json()) as T & { ok?: boolean; error?: string };
  } catch {
    throw new Error(`HTTP ${res.status} — invalid JSON response`);
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  return readJSON<T>(await authedFetch(withQuery(path, wsParam(currentWs)), init));
}

/** Like fetchJSON but scoped to an explicit workspace, not the active one. */
export async function scopedJSON<T>(path: string, ws: string, init?: RequestInit): Promise<T> {
  return readJSON<T>(await authedFetch(withQuery(path, ["ws=" + encodeURIComponent(ws)]), init));
}

export function postJSON<T = unknown>(path: string, body: unknown): Promise<T> {
  return fetchJSON<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getText(path: string): Promise<string | null> {
  const res = await authedFetch(withQuery(path, wsParam(currentWs)));
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
