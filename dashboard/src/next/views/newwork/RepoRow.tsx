/** Where new work lands: the active project's repository. The repo belongs to
 *  the project (server-side), so this row reads it from the workspace list and
 *  lets the operator set or change it inline — and, when there is no project at
 *  all yet, create one for a repo folder without leaving the sheet. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { postJSON, setRepoPath, setWs } from "../../../api.js";
import { toast } from "../../../core.js";
import { Folder, FolderPlus } from "../../icons.js";
import { useWarden } from "../../data.js";
import { Btn } from "../../ui.js";

/** The active project's repository ("" when none is set). */
export function useProjectRepo(): string {
  const w = useWarden();
  return w.workspaces.find((x) => x.name === w.ws)?.repo ?? "";
}

/** No project exists at all. The list loads async: with a remembered project
 *  name and an empty list it is still loading, not empty. */
export function useNoProject(): boolean {
  const w = useWarden();
  return w.workspaces.length === 0 && !w.ws;
}

export function RepoRow(): JSX.Element | null {
  const w = useWarden();
  const repo = useProjectRepo();
  const noProject = useNoProject();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(repo);
  useEffect(() => { setText(repo); if (repo) setRepoPath(repo); }, [repo]);

  const saveRepo = async (): Promise<void> => {
    try {
      await postJSON("/api/repo/path", { path: text.trim() });
      setRepoPath(text.trim());
      await w.reloadWorkspaces();
      setEditing(false);
      toast("Repository saved for this project.");
    } catch (err) { toast(String(err), true); }
  };

  // A fresh, isolated workspace bound to this repo — then switch to it and keep
  // this sheet open (switching projects closes overlays, so reopen it).
  const createProject = async (): Promise<void> => {
    try {
      const { name } = await postJSON<{ name: string }>("/api/projects", { repo: text.trim() });
      setWs(name); setRepoPath(text.trim());
      await w.reloadWorkspaces();
      w.switchWs(name);
      w.open({ type: "newwork" });
      toast(`Project “${name}” created — its backlog, runs and settings stay separate.`);
    } catch (err) { toast(String(err), true); }
  };

  if (!noProject && w.workspaces.length === 0) return null; // still loading
  if (!noProject && repo && !editing) {
    return (
      <div className="nw-repo">
        <Folder size={15} aria-hidden="true" />
        <span className="mono nw-repo-path" title={repo}>{repo}</span>
        <Btn small kind="ghost" onClick={() => setEditing(true)}>Change</Btn>
      </div>
    );
  }
  return (
    <div className="nw-repo-edit">
      <label className="field-label" htmlFor="nw-repo">{noProject ? "Create the project" : "Repository"}</label>
      <p className="hint">
        {noProject
          ? "A project is one repository. Point at its folder — a dedicated workspace is created so its work never mixes with another project's."
          : "The git repo this project's agents work in. New tickets and the planner use it."}
      </p>
      <div className="row nw-repo-input">
        <input id="nw-repo" className="input mono" placeholder="C:\path\to\your\repo" value={text}
          onChange={(e) => setText(e.target.value)} />
        {noProject
          ? <Btn kind="fill" disabled={!text.trim()} onClick={createProject}><FolderPlus size={15} /> Create project</Btn>
          : <Btn disabled={!text.trim() || text.trim() === repo} onClick={saveRepo}>Save</Btn>}
        {editing && <Btn kind="ghost" onClick={() => { setEditing(false); setText(repo); }}>Cancel</Btn>}
      </div>
    </div>
  );
}
