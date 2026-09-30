/** Pull requests — closes PR mode's loop inside Warden: the repo's open PRs
 *  (merge / close / read the changes, via `gh` on the server), the branches to
 *  open new ones from, and which delivery the current run uses. The repository
 *  is the project's own (project-repo.ts), not a browser-local guess. */

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { useWarden } from "../../data.js";
import { ExternalLink, GitPullRequest, RefreshCw } from "../../icons.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Empty, IconBtn, Spinner } from "../../ui.js";
import { RepoGate } from "../repo/RepoGate.js";
import { plainError } from "../repo/errors.js";
import { repoFetch, useProjectRepo } from "../repo/project-repo.js";
import { Branches } from "./Branches.js";
import { PrCard } from "./PrCard.js";
import type { OpenPr } from "./PrCard.js";

interface Loaded { prs: OpenPr[]; ghError: string; ghRaw: string; branches: string[]; current: string }

function usePullRequests(repo: string): { data: Loaded | null; reload: () => Promise<void> } {
  const [data, setData] = useState<Loaded | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    if (!repo) return;
    let prs: OpenPr[] = [];
    let ghError = "", ghRaw = "";
    try {
      const r = await fetchJSON<{ prs?: OpenPr[]; error?: string }>(`/api/prs?repo=${encodeURIComponent(repo)}`);
      prs = r.prs ?? [];
      if (r.error) ({ text: ghError, raw: ghRaw } = plainError(r.error, "GitHub couldn't list this repository's pull requests."));
    } catch (e) { ({ text: ghError, raw: ghRaw } = plainError(e, "Couldn't reach Warden.")); }
    let branches: string[] = [], current = "";
    try {
      const b = await repoFetch<{ branches?: string[]; current?: string }>(repo, "branches");
      branches = b.branches ?? []; current = b.current ?? "";
    } catch { /* branches are secondary; the PR error (if any) already says why */ }
    setData({ prs, ghError, ghRaw, branches, current });
  }, [repo]);
  useEffect(() => { setData(null); void reload(); }, [reload]);
  return { data, reload };
}

/** github.com/owner/name, read off any PR's URL. */
const repoWebUrl = (prs: OpenPr[]): string => prs[0]?.url.replace(/\/pull\/\d+$/, "") ?? "";

function Delivery(): JSX.Element | null {
  const w = useWarden();
  if (w.model.prMode === null) return null;
  return (
    <div className="card pr-delivery">
      <div className="stack pr-gap-2">
        <h2 className="card-title">{w.model.prMode ? "Delivery: a pull request per ticket" : "Delivery: merged into the base branch"}</h2>
        <p className="hint">
          {w.model.prMode
            ? "This run opens a PR for each verified ticket instead of merging locally. The base branch moves only when you merge here or on GitHub."
            : "This run merges each verified ticket straight into the base branch — no PRs are opened."}
        </p>
      </div>
      <Btn small onClick={() => w.go("settings", "safety")}>Change in Settings</Btn>
    </div>
  );
}

function Body({ repo, data, reload }: { repo: string; data: Loaded | null; reload: () => Promise<void> }): JSX.Element {
  const [acting, setActing] = useState<number | null>(null);
  if (!data) return <div className="rp-center"><Spinner /></div>;

  const act = async (n: number, kind: "merge" | "close"): Promise<void> => {
    setActing(n);
    try {
      await postJSON(`/api/prs/${kind}`, { repo, number: n });
      toast(`PR #${n} ${kind === "merge" ? "merged" : "closed"}.`);
      await reload();
    } catch (e) { toast(plainError(e, `Couldn't ${kind} PR #${n}.`).text, true); }
    finally { setActing(null); }
  };

  return (
    <>
      {data.ghError && <p className="rp-note" title={data.ghRaw || undefined}>{data.ghError}</p>}
      {data.prs.length > 0 ? (
        <section className="stack" aria-label="Open pull requests">
          <span className="label">Open · {data.prs.length}</span>
          {data.prs.map((pr) => (
            <PrCard key={pr.number} pr={pr} repo={repo} busy={acting === pr.number} locked={acting !== null} onAct={act} />
          ))}
        </section>
      ) : !data.ghError && (
        <Empty icon={<GitPullRequest size={22} />} title="No open pull requests">
          When a run delivers by PR, each verified ticket shows up here to merge. You can also open one from a branch below.
        </Empty>
      )}
      <Delivery />
      <Branches repo={repo} list={data.branches} current={data.current} onChanged={reload} />
    </>
  );
}

export function PullRequestsPage(): JSX.Element {
  const pr = useProjectRepo();
  const { data, reload } = usePullRequests(pr.repo);
  const web = data ? repoWebUrl(data.prs) : "";
  return (
    <>
      <Topbar title="Pull requests" sub={pr.name ? <span className="mono">{pr.name}</span> : undefined}>
        {pr.repo && <IconBtn label="Refresh" boxed onClick={() => { void reload(); }}><RefreshCw size={16} /></IconBtn>}
        {web && <Btn onClick={() => { window.open(web, "_blank", "noopener"); }}><ExternalLink size={14} /> Open on GitHub</Btn>}
      </Topbar>
      <div className="view narrow">
        <RepoGate pr={pr} why="Point it at the project's git repository to list its pull requests and branches here.">
          {(repo) => <Body repo={repo} data={data} reload={reload} />}
        </RepoGate>
      </div>
    </>
  );
}
