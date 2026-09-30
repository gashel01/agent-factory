/** Settings › Project: where the agents work (the repository, a project
 *  property stored server-side), its GitHub setup, the dependency install run
 *  in every fresh worktree, and the knowledge base. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { postJSON, setRepoPath } from "../../../api.js";
import { toast } from "../../../core.js";
import { useWarden } from "../../data.js";
import { Switch } from "../../ui.js";
import type { SectionProps } from "./GeneralSection.js";
import { Group, SettingRow } from "./parts.js";
import { RepoTools } from "./RepoTools.js";

export function ProjectSection({ s, set, onKnowledge }: SectionProps & { onKnowledge: (on: boolean) => Promise<void> }): JSX.Element {
  const w = useWarden();
  const current = w.workspaces.find((x) => x.name === w.ws)?.repo ?? "";
  const [repo, setRepo] = useState(current);
  useEffect(() => { setRepo(current); }, [current, w.ws]);

  const saveRepo = async (): Promise<void> => {
    if (repo.trim() === current) return;
    try {
      await postJSON("/api/repo/path", { path: repo.trim() });
      setRepoPath(repo.trim());
      await w.reloadWorkspaces();
      toast(repo.trim() ? "Repository saved for this project." : "Repository cleared.");
    } catch (err) { toast(String(err), true); }
  };

  return (
    <>
      <Group>
        <SettingRow label="Repository path" htmlFor="st-repo" stacked
          hint="The git repo your agents work in. New tickets default to it and the planner explores it. Set once per project — saved when you leave the field.">
          <input id="st-repo" className="input mono" placeholder="C:\path\to\your\repo" value={repo}
            onChange={(e) => setRepo(e.target.value)} onBlur={() => void saveRepo()}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </SettingRow>
        <SettingRow label="GitHub" stacked hint="Turn this folder into a git repo, publish it, or flip its visibility. Needs git and the gh CLI logged in.">
          <RepoTools repo={repo} />
        </SettingRow>
        <SettingRow label="Install dependencies" htmlFor="st-setup"
          hint="Run in every agent's fresh copy of the repo, before work starts. Comma-separated.">
          <input id="st-setup" className="input mono st-text" placeholder="npm install" value={s.setupCommands}
            onChange={(e) => set({ setupCommands: e.target.value })} />
        </SettingRow>
      </Group>
      <Group>
        <SettingRow label="Knowledge base"
          hint="Wire the project's documents (business rules, domain notes…) into every agent's next run. Takes effect right away — manage the documents on the Knowledge page.">
          <Switch label="Knowledge base" checked={s.knowledge} onChange={(v) => void onKnowledge(v)} />
        </SettingRow>
      </Group>
    </>
  );
}
