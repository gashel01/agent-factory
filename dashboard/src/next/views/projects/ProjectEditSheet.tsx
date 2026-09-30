/** Edit one project: rename it (PUT /api/workspaces/<name>), set its own budget
 *  cap (budget in its factory.yaml, through /api/config?ws=), or remove it from
 *  Warden — the registry entry only, files stay on disk, and never the last one.
 *  Same requests, order and messages as the classic ProjectEditor. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, scopedJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { generateConfig, parseSettings } from "../../../model.js";
import { useWarden } from "../../data.js";
import { Btn, Field, Sheet } from "../../ui.js";
import { ConfirmBtn, errText } from "./ConfirmBtn.js";

export function ProjectEditSheet({ name: original }: { name: string }): JSX.Element {
  const w = useWarden();
  const info = w.workspaces.find((x) => x.name === original);
  const canDelete = w.workspaces.length > 1;
  const [name, setName] = useState(original);
  const [budget, setBudget] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void scopedJSON<{ content: string }>("/api/config", original)
      .then(({ content }) => {
        const s = parseSettings(content);
        setBudget(s.budgetUsd ? String(s.budgetUsd) : "");
      })
      .catch(() => { /* no config yet — budget stays blank (no cap) */ })
      .finally(() => setLoaded(true));
  }, [original]);

  const save = async (): Promise<void> => {
    const newName = name.trim();
    if (!newName) { toast("A project needs a name.", true); return; }
    try {
      const trimmed = budget.trim();
      const cap = trimmed === "" ? null : Number(trimmed);
      if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error("The budget must be a positive number.");
      const { content } = await scopedJSON<{ content: string }>("/api/config", original);
      const s = parseSettings(content);
      await scopedJSON("/api/config", original, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: generateConfig({ ...s, budgetUsd: cap === null ? "" : String(cap) }) }),
      });
      if (newName !== original) {
        await fetchJSON(`/api/workspaces/${encodeURIComponent(original)}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
      }
      toast("Project updated.");
      await w.reloadWorkspaces();
      // Renaming the current project: follow it, or the shell would fall back to another one.
      if (newName !== original && w.ws === original) w.switchWs(newName);
      w.close();
    } catch (err) { toast(errText(err), true); }
  };

  const remove = async (): Promise<void> => {
    try {
      await fetchJSON(`/api/workspaces/${encodeURIComponent(original)}`, { method: "DELETE" });
      toast(`Removed ${original} from the dashboard. Its files stay on disk.`);
      await w.reloadWorkspaces();
      w.close();
    } catch (err) { toast(errText(err), true); }
  };

  return (
    <Sheet title="Edit project" eyebrow={<span className="label">{original}</span>} onClose={w.close}
      footer={<>
        <span className="spacer" />
        <Btn kind="ghost" onClick={w.close}>Cancel</Btn>
        <Btn kind="fill" disabled={!loaded} onClick={save}>Save</Btn>
      </>}>
      <Field label="Name" htmlFor="pj-edit-name" hint="Letters, numbers, spaces, dashes, dots or underscores.">
        <input id="pj-edit-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Repository" hint="Where agents work. Tickets can still point at another repo.">
        <div className="input mono pj-readonly" title={info?.repo ?? info?.workdir}>
          {info ? info.repo ?? info.workdir : "Unknown — this project may have been removed."}
        </div>
      </Field>
      {info?.repo && info.repo !== info.workdir && (
        <Field label="Workspace folder" hint="Where this project’s backlog, runs and settings live.">
          <div className="input mono pj-readonly">{info.workdir}</div>
        </Field>
      )}
      <Field label="Budget cap · USD, this project only" htmlFor="pj-edit-budget"
        hint="The run stops launching new agents once this project’s spend reaches the cap. Blank means no cap.">
        <input id="pj-edit-budget" className="input" type="number" min="0" step="1" value={budget}
          placeholder={loaded ? "No cap" : "Loading…"} disabled={!loaded} onChange={(e) => setBudget(e.target.value)} />
      </Field>
      <div className="divider" />
      <div className="card pj-danger">
        <div className="stack pj-danger-text">
          <b>Remove from Warden</b>
          <p className="hint">
            {canDelete ? "Only unregisters it. Your files and history stay on disk." : "The last project can’t be removed."}
          </p>
        </div>
        {canDelete && <ConfirmBtn small kind="danger" label="Remove" confirm="Sure? Click again" onConfirm={remove} />}
      </div>
    </Sheet>
  );
}
