/** GitHub actions for the project's repository: start a git repo in the
 *  folder, publish it, flip its visibility. Same endpoints and bodies as the
 *  classic RepoTools (work.tsx); only the markup is new. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { postJSON, setRepoPath } from "../../../api.js";
import { toast } from "../../../core.js";
import { FolderPlus, Upload } from "../../icons.js";
import { Btn, Seg } from "../../ui.js";

/** How long "Sure? Click again" stays armed. */
const CONFIRM_MS = 4000;

export function RepoTools({ repo }: { repo: string }): JSX.Element {
  const [vis, setVis] = useState<"private" | "public">("private");
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [armed]);

  const action = async (endpoint: string, withVis: boolean): Promise<void> => {
    setRepoPath(repo);
    try {
      const body: Record<string, string> = { path: repo.trim() };
      if (withVis) body.visibility = vis;
      const r = await postJSON<{ output?: string }>(endpoint, body);
      toast(r.output?.slice(-280) || "Done.");
    } catch (err) { toast(String(err), true); }
  };
  const none = !repo.trim();

  return (
    <div className="st-repo-tools">
      <Btn small disabled={none} onClick={() => action("/api/repo/init", false)}><FolderPlus size={14} /> Start a git repo here</Btn>
      <Seg label="Repository visibility" value={vis} onChange={setVis}
        options={[{ value: "private", label: "Private" }, { value: "public", label: "Public" }]} />
      <Btn small disabled={none} onClick={() => action("/api/repo/publish", true)}><Upload size={14} /> Publish to GitHub</Btn>
      <Btn small kind={armed ? "danger" : "default"} disabled={none}
        onClick={() => { if (!armed) { setArmed(true); return; } setArmed(false); return action("/api/repo/visibility", true); }}>
        {armed ? `Make it ${vis}? Click again` : "Set visibility"}
      </Btn>
    </div>
  );
}
