/** Repository — browse the project's code and history without leaving Warden.
 *
 *  Files (tree + highlighted file, deep-linked as #/repo/<path>), History (the
 *  all-branches railroad, a commit's diff, compare two commits), and the branch
 *  switcher in the header. The repository comes from the project on the server
 *  (see project-repo.ts), so it is there whenever the project has one; when it
 *  truly has none, the page lets you set it in place. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { useWarden } from "../../data.js";
import { GitBranch } from "../../icons.js";
import { Topbar } from "../../shell/Topbar.js";
import { Seg, Spinner } from "../../ui.js";
import { Files } from "./Files.js";
import { History } from "./History.js";
import { NotAGitRepo, RepoGate } from "./RepoGate.js";
import { plainError } from "./errors.js";
import { repoFetch, useProjectRepo } from "./project-repo.js";

type Tab = "files" | "history";
interface Branches { branches: string[]; current: string }

function readTab(): Tab {
  try { return localStorage.getItem("warden.next.repoTab") === "history" ? "history" : "files"; } catch { return "files"; }
}

/** The body once the repository is known: loads the tree + branches, and says so
 *  plainly when the folder isn't a git repository. */
function RepoBody({ repo, path, tab, branches, setBranches, version }: {
  repo: string; path: string; tab: Tab; branches: Branches | null;
  setBranches: (b: Branches) => void; version: number;
}): JSX.Element {
  const w = useWarden();
  const [files, setFiles] = useState<string[] | null>(null);
  const [err, setErr] = useState<{ text: string; notGit: boolean } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setErr(null);
    repoFetch<{ files: string[] }>(repo, "tree")
      .then((r) => { if (alive) setFiles(r.files); })
      .catch((e) => {
        if (!alive) return;
        const p = plainError(e, "Couldn't read the repository.");
        setErr({ text: p.text, notGit: /isn't a git repository/.test(p.text) });
        setFiles([]);
      });
    repoFetch<Branches>(repo, "branches").then((b) => { if (alive) setBranches(b); }).catch(() => { /* the tree error says why */ });
    return () => { alive = false; };
  }, [repo, version, retry]);

  if (err?.notGit) return <NotAGitRepo repo={repo} onDone={() => setRetry((n) => n + 1)} />;
  if (err) return <p className="rp-note">{err.text}</p>;
  if (files === null) return <div className="rp-center"><Spinner /></div>;
  return tab === "files"
    ? <Files repo={repo} path={path} files={files} branch={branches?.current ?? ""} onOpen={(p) => w.go("repo", p)} />
    : <History repo={repo} branches={branches?.branches ?? []} version={version} />;
}

export function RepoPage({ path }: { path: string }): JSX.Element {
  const w = useWarden();
  const pr = useProjectRepo();
  const [tab, setTabState] = useState<Tab>(() => (path ? "files" : readTab()));
  const [branches, setBranches] = useState<Branches | null>(null);
  const [version, setVersion] = useState(0);
  const setTab = (t: Tab): void => {
    setTabState(t);
    try { localStorage.setItem("warden.next.repoTab", t); } catch { /* private mode */ }
  };
  // A deep link to a file always shows the file.
  useEffect(() => { if (path) setTabState("files"); }, [path]);
  useEffect(() => { setBranches(null); }, [pr.repo]);

  const switchTo = async (branch: string): Promise<void> => {
    if (!branches || branch === branches.current) return;
    try {
      await postJSON("/api/repo/switch", { path: pr.repo, branch });
      toast(`Now on ${branch}.`);
      setVersion((v) => v + 1);
    } catch (e) { toast(plainError(e, `Couldn't switch to ${branch}.`).text, true); }
  };

  return (
    <>
      <Topbar title="Repository" sub={pr.name ? <span className="mono">{pr.name}</span> : undefined}>
        {pr.repo && branches && branches.branches.length > 0 && (
          <label className="rp-branch" title={w.live ? "Branches can't change while a run is in progress" : "Switch the checked-out branch"}>
            <GitBranch size={15} aria-hidden="true" />
            <select className="rp-select" value={branches.current} aria-label="Checked-out branch" disabled={w.live}
              onChange={(e) => void switchTo(e.currentTarget.value)}>
              {!branches.branches.includes(branches.current) && <option value={branches.current}>{branches.current}</option>}
              {branches.branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        )}
        {pr.repo && (
          <Seg label="Repository view" value={tab} onChange={setTab}
            options={[{ value: "files", label: "Files" }, { value: "history", label: "History" }]} />
        )}
      </Topbar>
      <div className="view rp-view">
        <RepoGate pr={pr} why="Point it at the folder that holds the project's git repository to browse its files and history here.">
          {(repo) => <RepoBody repo={repo} path={path} tab={tab} branches={branches} setBranches={setBranches} version={version} />}
        </RepoGate>
      </div>
    </>
  );
}
