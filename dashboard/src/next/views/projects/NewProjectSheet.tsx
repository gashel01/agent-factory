/** "New project" once at least one project exists: point Warden at a repository
 *  and the server creates a dedicated, isolated workspace for it (its state in
 *  <repo>/.factory — POST /api/projects, the classic New-project flow). Then the
 *  new project becomes the current one and New work opens on its empty board,
 *  where the classic modal went on to draft tickets inline. */

import { useState } from "react";
import type { JSX } from "react";
import { postJSON, setRepoPath } from "../../../api.js";
import { toast } from "../../../core.js";
import { useWarden } from "../../data.js";
import { FolderPlus } from "../../icons.js";
import { Btn, Field, Seg, Sheet } from "../../ui.js";
import { baseName } from "./portfolio.js";
import { errText } from "./ConfirmBtn.js";
import { ModelChoice } from "./ModelChoice.js";
import type { StartingModel } from "./ModelChoice.js";

export function NewProjectSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const w = useWarden();
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<"existing" | "fresh">("existing");
  const [model, setModel] = useState<StartingModel>("");
  const dir = repo.trim();

  const create = async (): Promise<void> => {
    if (!dir) { toast("Point the project at a repository first.", true); return; }
    if (!model) { toast("Pick a starting model first.", true); return; }
    try {
      if (fresh === "fresh") await postJSON("/api/repo/init", { path: dir });
      const r = await postJSON<{ name: string }>("/api/projects", { repo: dir, name: name.trim() || undefined, model });
      setRepoPath(dir);
      await w.reloadWorkspaces();
      onCreated();
      toast(`Isolated workspace ready for “${r.name}”.`);
      w.switchWs(r.name);
      w.go("board");
      w.open({ type: "newwork", tab: "goal" });
    } catch (err) { toast(errText(err), true); }
  };

  return (
    <Sheet title="New project" onClose={onClose}
      footer={<>
        <span className="spacer" />
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="fill" disabled={!dir || !model} onClick={create}><FolderPlus size={15} /> Create project</Btn>
      </>}>
      <p className="hint">
        A project is one repository. Warden creates a dedicated, isolated workspace for it, so its backlog, runs and
        settings never mix with another project’s. You draft its work right after.
      </p>
      <Field label="Repository path" htmlFor="pj-new-repo"
        hint={fresh === "fresh" ? "The folder is created and git init’d with a first commit." : "An existing folder on this machine."}>
        <input id="pj-new-repo" className="input mono" placeholder="C:\path\to\your\repo" value={repo}
          onChange={(e) => setRepo(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Seg label="Repository" value={fresh} onChange={setFresh}
        options={[{ value: "existing", label: "Use an existing repo" }, { value: "fresh", label: "Start fresh here" }]} />
      <Field label="Name · optional" htmlFor="pj-new-name" hint="Defaults to the folder’s name.">
        <input id="pj-new-name" className="input" placeholder={dir ? baseName(dir) : "my-project"} value={name}
          onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <ModelChoice value={model} onChange={setModel} />
      <p className="hint">Publishing to GitHub and the repository’s visibility live in Settings › Repository once the project exists.</p>
    </Sheet>
  );
}
