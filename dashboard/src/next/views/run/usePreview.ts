/** The live preview of the built product — the classic cockpit-preview.tsx
 *  logic: detect what the repo is (web app with a dev script, static site, or
 *  neither), start the server, poll until it serves, stop it. One difference on
 *  purpose: the classic modal booted the dev server the moment it opened; a
 *  page you merely navigate to only reads the current state, and boots on
 *  "Start preview". */

import { useEffect, useState } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { plainError } from "../repo/errors.js";
import { usePollers } from "./pollers.js";

/** Status poll cadence while the dev server boots. */
const PREVIEW_POLL_MS = 1500;
/** How much of the server's output to keep on screen. */
const PREVIEW_OUTPUT_TAIL_CHARS = 4000;

export type PreviewKind = "web" | "static" | "none";
export type PreviewState = "idle" | "starting" | "ready" | "error";

export interface Preview {
  /** null until detection answered. */
  kind: PreviewKind | null;
  script: string;
  state: PreviewState;
  url: string | null;
  output: string;
  /** A plain-words problem (detection or start failed). */
  problem: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface Status { state: PreviewState; url: string | null; output: string }

export function usePreview(repo: string, ws: string): Preview {
  const [kind, setKind] = useState<PreviewKind | null>(null);
  const [script, setScript] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle", url: null, output: "" });
  const [problem, setProblem] = useState("");
  const poll = usePollers();

  const apply = (p: Status): void =>
    setStatus({ state: p.state, url: p.url, output: p.output.slice(-PREVIEW_OUTPUT_TAIL_CHARS) });

  const follow = (): void => {
    poll("preview", async (stop) => {
      const p = await fetchJSON<Status>("/api/preview");
      apply(p);
      if (p.state === "ready" || p.state === "error" || p.state === "idle") stop();
    }, PREVIEW_POLL_MS);
  };

  useEffect(() => {
    let alive = true;
    setKind(null); setProblem("");
    // What's already running for this project (a preview survives page changes).
    fetchJSON<Status>("/api/preview").then((p) => {
      if (!alive) return;
      apply(p);
      if (p.state === "starting") follow();
    }).catch(() => { /* the detect call below reports reachability */ });
    if (!repo) return () => { alive = false; };
    fetchJSON<{ kind: PreviewKind; script?: string }>(`/api/preview/detect?repo=${encodeURIComponent(repo)}`)
      .then((d) => { if (alive) { setKind(d.kind); setScript(d.script ?? ""); } })
      .catch((e) => { if (alive) setProblem(plainError(e, "Couldn't inspect the project.").text); });
    return () => { alive = false; };
  }, [repo, ws]);

  const start = async (): Promise<void> => {
    setProblem("");
    try { await postJSON("/api/preview", { repo }); }
    catch (e) { setProblem(plainError(e, "Couldn't start the preview.").text); return; }
    setStatus((s) => ({ ...s, state: "starting", url: null }));
    follow();
  };
  const stop = async (): Promise<void> => {
    try { await postJSON("/api/preview/stop", {}); toast("Preview server stopped."); }
    catch (e) { toast(plainError(e, "Couldn't stop the preview.").text, true); }
    setStatus((s) => ({ ...s, state: "idle", url: null }));
  };

  return { kind, script, ...status, problem, start, stop };
}
