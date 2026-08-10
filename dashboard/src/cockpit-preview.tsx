import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, fetchJSON, postJSON, repoPath } from "./api.js";
import { RotateCw, Eye, ExternalLink } from "./icons.js";
import { toast } from "./core.js";
import { ConfirmButton, Modal } from "./widgets.js";

export function PreviewModal({ onClose, onFiles }: { onClose: () => void; onFiles: () => void }): JSX.Element {
  const [status, setStatus] = useState("Detecting the project…");
  const [out, setOut] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    const repo = repoPath();
    if (!repo) { setStatus("Set a repository path in New work first."); return; }
    let alive = true, timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      let det: { kind: string };
      try { det = await fetchJSON(`/api/preview/detect?repo=${encodeURIComponent(repo)}`); }
      catch (err) { setStatus(String(err)); return; }
      if (det.kind === "none") { toast("Not a web project — opening the files instead."); onFiles(); return; }
      setStatus(det.kind === "web" ? "Booting the dev server… first start can take a moment." : "Serving the site…");
      try { await postJSON("/api/preview", { repo }); } catch (err) { setStatus(String(err)); return; }
      timer = setInterval(async () => {
        let p: { state: string; url: string | null; output: string };
        try { p = await fetchJSON("/api/preview"); } catch { return; }
        if (!alive) return;
        if (p.output.trim()) setOut(p.output.slice(-1500));
        if (p.state === "ready" && p.url) {
          setUrl(p.url); setStatus(`Live at ${p.url}`);
          if (timer) clearInterval(timer);
        } else if (p.state === "error") { setStatus("Could not start the preview — see output."); if (timer) clearInterval(timer); }
        else if (p.state === "idle") { setStatus("The preview server stopped."); if (timer) clearInterval(timer); }
      }, 1500);
    })();
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, []);

  return (
    <Modal title="Live preview" onClose={onClose} wide>
      <div className="preview-status">{status}</div>
      {url ? (
        <>
          <div className="preview-bar">
            <span className="preview-url mono">{url}</span>
            <div className="preview-bar-acts">
              <button className="btn ghost sm" onClick={() => setReloadKey((k) => k + 1)} title="Reload the embedded view"><RotateCw size={13} /> Refresh</button>
              {/* Freeze-frame the running app — visual evidence you can keep or show the supervisor. */}
              <button className="btn ghost sm" onClick={() => window.open(api("/api/preview/shot"), "_blank")} title="Capture a screenshot of the running app"><Eye size={13} /> Full shot</button>
              <button className="btn ghost sm" onClick={() => window.open(url, "_blank")}><ExternalLink size={13} /> Open in tab</button>
              <ConfirmButton label="Stop" confirm="Sure? Click again" plain
                onConfirm={async () => { try { await postJSON("/api/preview/stop", {}); toast("Preview server stopped."); } catch (err) { toast(String(err), true); } onClose(); }} />
            </div>
          </div>
          {/* Watch the app the agent is building, live and in-cockpit. Some frameworks
              refuse to be framed; the "Open in tab" fallback always works. */}
          <iframe key={reloadKey} className="preview-frame" src={url} title="Live preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
        </>
      ) : (
        out && <pre className="log-pre preview-out">{out}</pre>
      )}
      {url && out && (
        <button className="btn link" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide server log" : "Show server log"}</button>
      )}
      {url && showLog && out && <pre className="log-pre preview-out">{out}</pre>}
    </Modal>
  );
}
