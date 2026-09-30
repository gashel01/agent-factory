/** What the repo-backed pages show before they have a repository to read:
 *  loading, "Warden is unreachable", or — when the project really has no repo —
 *  a one-field form to set it right here (the classic modal sent you to the New
 *  work panel instead). Also the "not a git repository yet" card, which offers
 *  the same one-click `git init` the Projects screen uses. */

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { FolderOpen, GitBranch } from "../../icons.js";
import { Btn, Empty, Field, Spinner } from "../../ui.js";
import { plainError } from "./errors.js";
import type { ProjectRepo } from "./project-repo.js";

function SetRepoForm({ pr, why }: { pr: ProjectRepo; why: string }): JSX.Element {
  const [path, setPath] = useState(pr.suggestion);
  const [err, setErr] = useState("");
  const save = async (): Promise<void> => {
    if (!path.trim()) return;
    try { await pr.setPath(path); setErr(""); toast("Repository set for this project."); }
    catch (e) { setErr(plainError(e, "Couldn't save that path.").text); }
  };
  return (
    <div className="card rp-setup">
      <div className="row"><span className="empty-state-icon" aria-hidden="true"><FolderOpen size={22} /></span>
        <div className="stack rp-setup-text">
          <b>This project has no repository yet</b>
          <p className="hint">{why}</p>
        </div>
      </div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Repository folder" htmlFor="rp-setup-path"
          hint={pr.suggestion ? "Prefilled with the folder this browser last used — check it's the right project." : "The folder on this machine that holds the project's git repository."}>
          <input id="rp-setup-path" className="input mono" value={path} placeholder="C:\path\to\project"
            onChange={(e) => setPath(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
        </Field>
        {err && <p className="rp-note">{err}</p>}
        <div className="row"><Btn kind="fill" disabled={!path.trim()} onClick={save}>Use this folder</Btn></div>
      </form>
    </div>
  );
}

/** Renders `children(repo)` once the project's repository is known. */
export function RepoGate({ pr, why, children }: { pr: ProjectRepo; why: string; children: (repo: string) => ReactNode }): JSX.Element {
  if (pr.loading) return <div className="rp-center"><Spinner /></div>;
  if (pr.error) {
    return <Empty title="Couldn't load the project" action={<Btn onClick={pr.reload}>Try again</Btn>}>{pr.error}</Empty>;
  }
  if (!pr.repo) return <SetRepoForm pr={pr} why={why} />;
  return <>{children(pr.repo)}</>;
}

/** The repo path exists but has no .git: offer to initialise it. */
export function NotAGitRepo({ repo, onDone }: { repo: string; onDone: () => void }): JSX.Element {
  const init = async (): Promise<void> => {
    try {
      await postJSON("/api/repo/init", { path: repo });
      toast("Git repository initialised on main.");
      onDone();
    } catch (e) { toast(plainError(e, "Couldn't initialise git there.").text, true); }
  };
  return (
    <Empty icon={<GitBranch size={22} />} title="This folder isn't a git repository yet"
      action={<Btn kind="fill" onClick={init}>Initialise git here</Btn>}>
      <span className="mono">{repo}</span> — Warden needs git to track the agents' work. Initialising creates a <span className="mono">main</span> branch with a first commit.
    </Empty>
  );
}
