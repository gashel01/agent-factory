/** Which repository the Repository, Pull requests and Run pages look at.
 *
 *  The classic modals read `repoPath()` — a browser-local copy of the path that
 *  only the New work panel writes. A project opened from the Projects screen,
 *  another browser or the phone therefore had a repo on the server but an empty
 *  local copy, and the modal said "Set a repository path in the New work panel
 *  first" although the path existed. (Worse, a stale local copy could show
 *  ANOTHER project's repo.) The truth lives on the server: /api/workspaces gives
 *  each project's repo (explicit path, or the one its tickets target). This hook
 *  reads it from there, and sets it through the per-project /api/repo/path. */

import { useCallback, useEffect, useState } from "react";
import { fetchJSON, postJSON, repoPath, setRepoPath } from "../../../api.js";
import type { WorkspaceInfo } from "../../../core.js";
import { useWarden } from "../../data.js";

export interface ProjectRepo {
  /** Absolute repo path, "" when the project has none. */
  repo: string;
  /** Short display name (last path segment). */
  name: string;
  loading: boolean;
  /** Plain-words failure to reach the server, "" otherwise. */
  error: string;
  /** A path this browser remembers (classic panel), offered as a suggestion when the project has none. */
  suggestion: string;
  reload: () => Promise<void>;
  /** Persist a repo path for the current project. Throws on failure. */
  setPath: (path: string) => Promise<void>;
}

export const repoName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function useProjectRepo(): ProjectRepo {
  const w = useWarden();
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const { workspaces } = await fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
      const found = workspaces.find((x) => x.name === w.ws)?.repo ?? "";
      setRepo(found);
      setError("");
      // Keep the locally remembered repo path in step with the project.
      if (found) setRepoPath(found);
    } catch {
      setError("Couldn't reach Warden to find this project's repository.");
    } finally {
      setLoading(false);
    }
  }, [w.ws]);

  useEffect(() => { setLoading(true); void reload(); }, [reload]);

  const setPath = async (path: string): Promise<void> => {
    const r = await postJSON<{ ok?: boolean; repo?: string | null }>("/api/repo/path", { path: path.trim() });
    if (r.repo) setRepoPath(r.repo);
    await reload();
    await w.reloadWorkspaces();
  };

  const local = repoPath();
  return {
    repo, name: repo ? repoName(repo) : "", loading, error,
    suggestion: !repo && local ? local : "",
    reload, setPath,
  };
}

/** GET one of the path-scoped /api/repo/* endpoints for an explicit repo. */
export function repoFetch<T>(repo: string, endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ repo, ...params });
  return fetchJSON<T>(`/api/repo/${endpoint}?${qs}`);
}
