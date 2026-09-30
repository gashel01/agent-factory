/** Direct / Sandbox picker with a live Docker preflight and a one-click image
 *  build. Same endpoints and cadence as the classic control: /api/docker is only
 *  polled while Sandbox is selected, so a Direct project pays nothing. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast, usePolling } from "../../../core.js";
import type { DockerStatus } from "../../../api-shapes.js";
import { Check, Laptop, Lock } from "../../icons.js";
import { Btn, Seg } from "../../ui.js";

/** Docker preflight cadence while Sandbox is selected. */
const DOCKER_POLL_MS = 3000;

function Line({ ok, children }: { ok: boolean; children: string }): JSX.Element {
  return <span className="st-sbx-line"><span className={`st-sbx-dot${ok ? " on" : ""}`} aria-hidden="true" />{children}</span>;
}

export function SandboxControl({ value, onChange }: {
  value: "direct" | "sandbox"; onChange: (v: "direct" | "sandbox") => void;
}): JSX.Element {
  const [st, setSt] = useState<DockerStatus | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { if (value !== "sandbox") { setSt(null); setErr(false); } }, [value]);
  usePolling(async ({ alive }) => {
    try {
      const s = await fetchJSON<DockerStatus>("/api/docker");
      if (alive()) { setSt(s); setErr(false); }
    } catch { if (alive()) setErr(true); }
  }, DOCKER_POLL_MS, [value], value === "sandbox");

  const build = async (): Promise<void> => {
    try { await postJSON("/api/docker/build", {}); toast("Building the sandbox image — runs once (~1–3 min)."); }
    catch (e) { toast(String(e), true); }
  };

  return (
    <div className="st-sbx">
      <Seg label="Sandboxing" value={value} onChange={onChange} options={[
        { value: "direct", label: <span className="row st-seg-icon"><Laptop size={14} /> Direct</span> },
        { value: "sandbox", label: <span className="row st-seg-icon"><Lock size={14} /> Sandbox</span> },
      ]} />
      {value === "sandbox" && (
        <div className="st-sbx-status" role="status">
          {!st && err ? (
            <span className="hint">Couldn't reach the Warden server to check Docker — is it still running? Retrying…</span>
          ) : !st ? (
            <span className="hint">Checking Docker…</span>
          ) : (
            <>
              <Line ok={st.engine}>{`Docker engine ${st.engine ? "ready" : "off"}`}</Line>
              <Line ok={st.image}>{`Sandbox image ${st.image ? "built" : "missing"}`}</Line>
              {st.engine && st.image ? (
                <span className="st-sbx-ready"><Check size={14} /> Confined runs ready — only the worktree is visible, egress limited to Anthropic. The proxy starts on your first run.</span>
              ) : st.building ? (
                <span className="hint">Building the image… {st.buildLog?.split("\n").filter(Boolean).slice(-1)[0] ?? ""}</span>
              ) : !st.engine ? (
                <span className="hint">{st.detail || "Start Docker Desktop — this refreshes by itself."}</span>
              ) : (
                <Btn small onClick={build}>Build sandbox image</Btn>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
