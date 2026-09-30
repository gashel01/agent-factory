/** First run (no project registered yet): name a project, point it at a folder
 *  (existing repo or a fresh git init), pick the stack and an optional budget.
 *  Same requests as the classic Onboarding: /api/repo/init when fresh, then
 *  POST /api/workspaces, then a starter factory.yaml via PUT /api/config?ws=. */

import { useState } from "react";
import type { JSX } from "react";
import { postJSON, scopedJSON, setRepoPath } from "../../../api.js";
import { toast } from "../../../core.js";
import { generateConfig } from "../../../model.js";
import type { Settings } from "../../../model.js";
import { useWarden } from "../../data.js";
import { ArrowRight, ShieldCheck } from "../../icons.js";
import { Btn, Field, Seg } from "../../ui.js";
import { errText } from "./ConfirmBtn.js";
import { ModelChoice } from "./ModelChoice.js";
import type { StartingModel } from "./ModelChoice.js";

const SETUP_FOR: Record<Settings["project"], string> = { node: "npm install", python: "uv sync", other: "" };

export function Onboarding({ onCreated }: { onCreated: () => void }): JSX.Element {
  const w = useWarden();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [fresh, setFresh] = useState<"existing" | "fresh">("existing");
  const [project, setProject] = useState<Settings["project"]>("node");
  const [budget, setBudget] = useState("");
  const [model, setModel] = useState<StartingModel>("");
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(name.trim());
  const ready = nameOk && folder.trim() !== "" && model !== "";

  const create = async (): Promise<void> => {
    const ws = name.trim(), dir = folder.trim();
    try {
      if (fresh === "fresh") await postJSON("/api/repo/init", { path: dir });
      await postJSON("/api/workspaces", { name: ws, workdir: dir });
      const cfg = generateConfig({
        slots: 3, internet: false, project, setupCommands: SETUP_FOR[project],
        integrationCommands: "", reviewer: false, reviewerModel: "haiku", planModel: "",
        model, effort: "", maxRetries: 1, budgetUsd: budget.trim(), manualApproval: false,
        verifyCommands: "", requireVerify: true, candidates: 1, reviewOnFailure: "hold",
        prNative: false, webhookUrl: "", executionMode: "subscription", isolation: "direct",
        knowledge: false,
      });
      await scopedJSON("/api/config", ws, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cfg }),
      });
      setRepoPath(dir);
      await w.reloadWorkspaces();
      onCreated();
      toast(`Project "${ws}" is ready.`);
      w.switchWs(ws);
      w.go("board");
    } catch (err) { toast(errText(err), true); }
  };

  const reassure = project === "python" ? "Runs uv sync, then lands you on the board."
    : project === "node" ? "Runs npm install, then lands you on the board."
      : "Lands you straight on the board.";

  return (
    <div className="pj-onboard">
      <div className="pj-onboard-mark" aria-hidden="true"><ShieldCheck size={28} strokeWidth={2} /></div>
      <h2 className="pj-onboard-title">Let’s set up your first project.</h2>
      <p className="hint pj-onboard-thesis">
        A project is a work folder Warden drives agents against — in parallel, each behind one deterministic gate.
        No terminal needed.
      </p>
      <div className="card pj-onboard-card">
        <Field label="Project name" htmlFor="pj-ob-name"
          hint={name.trim() && !nameOk ? "Use only letters, numbers, dashes or underscores." : undefined}>
          <input id="pj-ob-name" className="input" placeholder="my-project" value={name}
            onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Repository / work folder" htmlFor="pj-ob-folder"
          hint={fresh === "fresh" ? "The folder is created and git init’d with a first commit." : undefined}>
          <input id="pj-ob-folder" className="input mono" placeholder="C:\path\to\your\repo" value={folder}
            onChange={(e) => setFolder(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Seg label="Repository" value={fresh} onChange={setFresh}
          options={[{ value: "existing", label: "Use an existing repo" }, { value: "fresh", label: "Start fresh here" }]} />
        <div className="pj-onboard-row">
          <div className="field">
            <span className="field-label">Stack</span>
            <Seg label="Stack" value={project} onChange={setProject}
              options={[{ value: "node", label: "Node" }, { value: "python", label: "Python" }, { value: "other", label: "Other" }]} />
          </div>
          <Field label="Budget · USD, optional" htmlFor="pj-ob-budget">
            <input id="pj-ob-budget" className="input" type="number" min="0" placeholder="No cap" value={budget}
              onChange={(e) => setBudget(e.target.value)} />
          </Field>
        </div>
        <ModelChoice value={model} onChange={setModel} />
        <div className="row pj-onboard-foot">
          <Btn kind="fill" disabled={!ready} onClick={create}>Create project <ArrowRight size={14} /></Btn>
          <span className="hint">{reassure}</span>
        </div>
      </div>
    </div>
  );
}
