/* Extracted from app.tsx — mechanical split. */
/** Agent Factory dashboard — React app. Mounts into #app. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type {
  BlockedContext, FactoryEvent, TaskState,
  CapsuleAction, CapsuleConsent, CapsulePanel, CapsuleView,
} from "./types.js";
import {
  api, fetchJSON, getText, getWs, initToken, initWs, postJSON, repoGet, repoPath, scopedJSON, setRepoPath, setWs,
} from "./api.js";
import {
  ACTIVITY, Checkpoint, EFFORT_CHOICES, HistoryTicket, MODEL_CHOICES, Model, Settings, StoryItem, TaskModel,
  ago, fmtDuration, fmtTokens, fmtUsd, freshModel, generateConfig, inFlight, narrate,
  parseSettings, reduce, seedHistory,
} from "./model.js";
import { langFromPath } from "./highlight.js";
import { CodeLine, Diff } from "./diff-view.js";
import { qrSvg } from "./qr.js";
import type { Observation } from "./companion.js";
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine,
  BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleDot, CircleHelp, Command, CompanionIcon, CornerDownLeft, CornerDownRight,
  ExternalLink, Eye, FileText, FlaskConical, Flag, Folder, FolderOpen, FolderPlus,
  GitBranch, GitMerge, Globe, InfinityIcon, Key, Laptop, Lightbulb, ListChecks, Lock, MessageCircle,
  MoreHorizontal, Palette, Pause, Pencil, Play, Plus, RotateCw, Search, Send,
  ShieldCheck, Smartphone, Sparkles, Square, Terminal, Timer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";
import { AttachStrip, Button, toast, useAttachments, useManagedInterval } from "./core.js";
import { NetInfo, Onboarding } from "./screens.js";
import { ConfirmButton, Modal, Select } from "./widgets.js";

/* --------------------------------- Preview modal --------------------------------- */

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

/* --------------------------------- Cockpit (capsule) ---------------------------------
 * A generic, app-agnostic project cockpit driven entirely by the project's capsule.
 * The factory renders a FIXED palette (doctor chips, action buttons, log-stream,
 * device-install, preview, consent cards); the capsule (data) decides what appears.
 * Nothing here knows "mobile" or any app type — mobile is just one capsule. */

/** Safe icon allow-list — the capsule references names, never emits UI code. */
export function capsuleIcon(name: string | undefined, size = 14): JSX.Element {
  switch (name) {
    case "smartphone": case "phone": return <Smartphone size={size} />;
    case "external": case "link": case "download": return <ExternalLink size={size} />;
    case "eye": case "preview": return <Eye size={size} />;
    default: return <Play size={size} />;
  }
}

/** A host-mutation approval: the user sees the RAW facts (URLs, checksums, paths,
 *  env, commands) verbatim — never the agent's paraphrase. Anti-injection contract. */
export function ConsentCard({ consent, onApprove }: { consent: CapsuleConsent; onApprove: () => void }): JSX.Element {
  const f = consent.facts;
  const list = (label: string, items: JSX.Element[]): JSX.Element | null =>
    items.length ? <div className="consent-group"><b>{label}</b><ul>{items}</ul></div> : null;
  return (
    <div className="consent-card">
      <div className="consent-title"><TriangleAlert size={15} /> {consent.title}</div>
      {consent.summary && <p className="phone-sub">{consent.summary}</p>}
      <div className="consent-facts">
        {list("Downloads", (f.downloads ?? []).map((d, i) => (
          <li key={i}><code>{d.url}</code>{d.sha256 && <span className="consent-sha"> · sha256 {d.sha256.slice(0, 16)}…</span>}</li>
        )))}
        {list("Writes", (f.writes ?? []).map((w, i) => <li key={i}><code>{w}</code></li>))}
        {list("Env", Object.entries(f.env ?? {}).map(([k, v]) => <li key={k}><code>{k}={v}</code></li>))}
        {list("Commands", (f.commands ?? []).map((c, i) => <li key={i}><code>{c}</code></li>))}
      </div>
      <div className="card-actions">
        <Button kind="btn" variant="primary" autoPending onClick={onApprove}><Check size={14} /> Approve &amp; run</Button>
      </div>
    </div>
  );
}

/** The device-install surface: QR to sideload over the LAN + download + per-device
 *  one-click install. Fully generic — the capsule declares the artifact and the
 *  list/install commands as data. */
export function DeviceInstall(
  { action, devices, lanBase }: { action: CapsuleAction; devices: string[]; lanBase: string },
): JSX.Element {
  const artifactUrl = lanBase
    ? `${lanBase}/api/capsule/artifact?ws=${encodeURIComponent(getWs())}&id=${encodeURIComponent(action.id)}`
    : null;
  const qr = artifactUrl ? qrSvg(artifactUrl, { ec: "M", scale: 5, border: 2, dark: "#0b0b0c", light: "#ffffff" }) : "";
  return (
    <div className="mobile-ready">
      {qr && <div className="mobile-qr"><div className="phone-qr" dangerouslySetInnerHTML={{ __html: qr }} /></div>}
      <div className="mobile-ready-body">
        <div className="mobile-ready-title"><Smartphone size={15} /> Install on a device</div>
        <p className="phone-sub">Scan the code with a device on the same Wi-Fi, download, then open it (allow “install from unknown sources”).</p>
        <div className="mobile-actions">
          <button className="btn" onClick={() => window.open(api(`/api/capsule/artifact?id=${encodeURIComponent(action.id)}`), "_blank")}>
            <ExternalLink size={14} /> Download
          </button>
          {devices.map((d) => (
            <Button key={d} kind="btn" variant="primary" autoPending onClick={async () => {
              try {
                const r = await postJSON<{ output: string }>("/api/capsule/install", { id: action.id, device: d });
                toast(`Installed on ${d}.`);
                if (r.output) toast(r.output.slice(-160));
              } catch (e) { toast(String(e), true); }
            }}>
              <Smartphone size={14} /> Install to {d}
            </Button>
          ))}
        </div>
        {devices.length === 0 && (
          <p className="phone-sub subtle">No device detected over USB — plug one in (debugging on) to install directly, or just use the QR.</p>
        )}
      </div>
    </div>
  );
}

/** A read-only metrics/info panel: runs its declared command and shows the output. */
export function PanelCard({ panel }: { panel: CapsulePanel }): JSX.Element {
  const [out, setOut] = useState<string | null>(null);
  const load = (): void => {
    if (panel.html !== undefined) return; // html panels are static, nothing to fetch
    setOut(null);
    void fetchJSON<{ output: string }>(`/api/capsule/panel?id=${encodeURIComponent(panel.id)}`)
      .then((r) => setOut(r.output.trim() || "(no output)")).catch((e) => setOut(String(e)));
  };
  useEffect(load, [panel.id]);
  return (
    <div className="cockpit-panel">
      <div className="cockpit-panel-head">
        <span>{panel.title}</span>
        {panel.html === undefined && <button className="btn icon" title="Refresh" onClick={load}><RotateCw size={12} /></button>}
      </div>
      {panel.html !== undefined
        // Sandboxed: scripts run but no same-origin — isolated from the dashboard.
        ? <iframe className="cockpit-panel-html" sandbox="allow-scripts" srcDoc={panel.html} title={panel.title} />
        : <pre className="cockpit-panel-body">{out ?? "…"}</pre>}
    </div>
  );
}

export function CockpitModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [view, setView] = useState<CapsuleView | null>(null);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [openLog, setOpenLog] = useState<Record<string, boolean>>({});
  const [gen, setGen] = useState<{ state: string; output: string } | null>(null);
  const [prov, setProv] = useState<{ state: string; output: string } | null>(null);
  const [svc, setSvc] = useState<Record<string, { state: string; url: string | null }>>({});
  const [svcOut, setSvcOut] = useState<Record<string, string>>({});
  const [chatMsg, setChatMsg] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [draft, setDraft] = useState<Array<{ t: "ctx" | "add" | "del"; s: string }> | null>(null);
  const [judge, setJudge] = useState<Record<string, { state: string; verdict: string | null; confidence: number | null; reasons: string[]; hasShot: boolean }>>({});
  const poll = useManagedInterval();
  const judgePoll = useManagedInterval();
  const genPoll = useManagedInterval();
  const provPoll = useManagedInterval();
  const svcPoll = useManagedInterval();
  const chatPoll = useManagedInterval();

  const refresh = (): void => {
    void fetchJSON<CapsuleView>("/api/capsule").then(setView).catch((e) => toast(String(e), true));
  };
  const loadDraft = (): void => {
    void fetchJSON<{ has: boolean; diff: Array<{ t: "ctx" | "add" | "del"; s: string }> }>("/api/capsule/chat/draft")
      .then((d) => setDraft(d.has ? d.diff : null)).catch(() => {});
  };
  useEffect(() => {
    refresh();
    loadDraft();
    void fetchJSON<NetInfo>("/api/netinfo").then(setNet).catch(() => {});
  }, []);

  // Conversational edit: an agent rewrites capsule.json → a reviewable diff draft.
  const sendChat = async (): Promise<void> => {
    const message = chatMsg.trim();
    if (!message) return;
    try { await postJSON("/api/capsule/chat", { message }); }
    catch (e) { toast(String(e), true); return; }
    setChatMsg(""); setChatBusy(true);
    chatPoll((stop) => {
      void fetchJSON<{ state: string }>("/api/capsule/status?id=__chat__").then((s) => {
        if (s.state === "ok" || s.state === "error") {
          stop(); setChatBusy(false);
          if (s.state === "ok") { loadDraft(); toast("Proposed an edit — review the diff."); }
          else toast("Couldn't edit the capsule — try rephrasing.", true);
        }
      }).catch(() => {});
    }, 1500);
  };
  // Agent-judge: look at the running app (screenshot) / output → verdict vs criteria.
  const runJudge = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/judge", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setJudge((m) => ({ ...m, [a.id]: { state: "running", verdict: null, confidence: null, reasons: [], hasShot: false } }));
    judgePoll((stop) => {
      void fetchJSON<{ state: string; verdict: string | null; confidence: number | null; reasons: string[]; hasShot: boolean }>(`/api/capsule/judge?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setJudge((m) => ({ ...m, [a.id]: s }));
          if (s.state === "done" || s.state === "error") {
            stop();
            if (s.state === "done") toast(`${a.label}: ${s.verdict === "pass" ? "passes" : "fails"} the behavioral check.`, s.verdict !== "pass");
            else toast(`Judge failed on ${a.label}.`, true);
          }
        }).catch(() => {});
    }, 1500);
  };

  const applyChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/apply", {}); setDraft(null); toast("Applied."); refresh(); }
    catch (e) { toast(String(e), true); }
  };
  const discardChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/discard", {}); } catch { /* ignore */ }
    setDraft(null);
  };

  const runAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/action", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setBusy(a.id);
    setOpenLog((o) => ({ ...o, [a.id]: true }));
    poll((stop) => {
      void fetchJSON<{ state: string; output: string }>(`/api/capsule/status?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setLogs((l) => ({ ...l, [a.id]: s.output }));
          if (s.state === "ok" || s.state === "error") {
            stop(); setBusy(null); refresh();
            if (s.state === "ok") { toast(`${a.label} — done.`); setOpenLog((o) => ({ ...o, [a.id]: false })); }
            else toast(`${a.label} failed — see the output.`, true);
          }
        }).catch(() => {});
    }, 1200);
  };

  const grant = async (c: CapsuleConsent): Promise<void> => {
    try { await postJSON("/api/capsule/consent", { id: c.id }); toast(`${c.title} — provisioned.`); refresh(); }
    catch (e) { toast(String(e), true); }
  };

  // Ask AI to fix a failing action: an editing agent runs, then the engine
  // re-verifies the action's own commands (green only if the re-run passes).
  const fixAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/fix", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setBusy(a.id);
    setOpenLog((o) => ({ ...o, [a.id]: true }));
    poll((stop) => {
      void fetchJSON<{ state: string; output: string }>(`/api/capsule/status?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setLogs((l) => ({ ...l, [a.id]: s.output }));
          if (s.state === "ok" || s.state === "error") {
            stop(); setBusy(null); refresh();
            toast(s.state === "ok" ? `${a.label} fixed — it passes now.` : `Couldn't fix ${a.label} — see the output.`, s.state !== "ok");
          }
        }).catch(() => {});
    }, 1500);
  };

  // Long-running service actions (dev servers): start → capture URL → embed live.
  const startSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service", { id: a.id }); }
    catch (e) { toast(String(e), true); return; }
    setSvc((m) => ({ ...m, [a.id]: { state: "starting", url: null } }));
    svcPoll((stop) => {
      void fetchJSON<{ state: string; url: string | null; output: string }>(`/api/capsule/service?id=${encodeURIComponent(a.id)}`)
        .then((s) => {
          setSvc((m) => ({ ...m, [a.id]: { state: s.state, url: s.url } }));
          setSvcOut((o) => ({ ...o, [a.id]: s.output }));
          if (s.state === "live") { stop(); toast(`${a.label} is live.`); }
          else if (s.state === "error" || s.state === "stopped") { stop(); if (s.state === "error") toast(`${a.label} failed — see output.`, true); }
        }).catch(() => {});
    }, 1200);
  };
  const stopSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service/stop", { id: a.id }); } catch (e) { toast(String(e), true); }
    setSvc((m) => ({ ...m, [a.id]: { state: "stopped", url: null } }));
  };

  // Auto-provision: an agent diagnoses the failing doctor checks and proposes
  // install consents (raw facts) — the user approves before anything runs.
  const provision = async (): Promise<void> => {
    try { await postJSON("/api/capsule/provision", {}); }
    catch (e) { toast(String(e), true); return; }
    setProv({ state: "running", output: "" });
    provPoll((stop) => {
      void fetchJSON<{ state: string; output: string }>("/api/capsule/status?id=__provision__")
        .then((s) => {
          setProv(s);
          if (s.state === "ok" || s.state === "error") {
            stop();
            if (s.state === "ok") { toast("Install plan ready — review the facts and approve."); refresh(); }
            else toast("Provisioning diagnosis failed — see the output.", true);
          }
        }).catch(() => {});
    }, 1500);
  };

  // Onboarding agent: inspects the repo (read-only) and writes a capsule.json.
  const generate = async (): Promise<void> => {
    try { await postJSON("/api/capsule/generate", {}); }
    catch (e) { toast(String(e), true); return; }
    setGen({ state: "running", output: "" });
    genPoll((stop) => {
      void fetchJSON<{ state: string; output: string }>("/api/capsule/status?id=__generate__")
        .then((s) => {
          setGen(s);
          if (s.state === "ok" || s.state === "error") {
            stop();
            if (s.state === "ok") { toast("Cockpit generated — review it."); refresh(); }
            else toast("Generation failed — see the output.", true);
          }
        }).catch(() => {});
    }, 1500);
  };

  const capsule = view?.capsule ?? null;
  const grants = new Set(view?.grants ?? []);
  const lanBase = net?.url ?? "";
  const pending = (capsule?.consents ?? []).filter((c) => !grants.has(c.id));
  const granted = (capsule?.consents ?? []).filter((c) => grants.has(c.id));

  const judgeUI = (a: CapsuleAction): JSX.Element | null => {
    if (!a.judge) return null;
    const j = judge[a.id];
    return (
      <div className="judge-block">
        <button className="btn" disabled={j?.state === "running"} onClick={() => runJudge(a)}>
          <Eye size={14} /> {j?.state === "running" ? "Judging…" : "Judge (AI)"}
        </button>
        {j && j.state === "done" && j.verdict && (
          <div className="judge-result">
            <span className={`judge-badge ${j.verdict}`}>
              {j.verdict === "pass" ? <Check size={13} /> : <X size={13} />} {j.verdict.toUpperCase()}
              {j.confidence != null ? ` · ${Math.round(j.confidence * 100)}%` : ""}
            </span>
            {j.reasons.length > 0 && <ul className="judge-reasons">{j.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            {j.hasShot && <img className="judge-shot" src={api(`/api/capsule/judge/shot?id=${encodeURIComponent(a.id)}`)} alt="what the judge saw" />}
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal title={capsule?.name ? `Cockpit · ${capsule.name}` : "Project cockpit"} onClose={onClose} wide>
      {view && !capsule && (
        <div className="cockpit-empty">
          <div className="preview-status">No capsule for this project yet. The onboarding agent will inspect the repo (read-only) and generate one — the build / test / run recipe plus the controls to render here.</div>
          <div className="card-actions">
            <Button kind="btn" variant="primary" autoPending disabled={gen?.state === "running"} onClick={generate}>
              <Sparkles size={14} /> {gen?.state === "running" ? "Inspecting the repo…" : "Generate cockpit"}
            </Button>
          </div>
        </div>
      )}
      {gen && (gen.state === "running" || gen.state === "error") && gen.output && (
        <details className="mobile-log" open>
          <summary><ChevronDown size={13} /> Onboarding agent</summary>
          <pre className="log-pre">{gen.output}</pre>
        </details>
      )}
      {capsule?.summary && <p className="phone-sub" style={{ marginTop: 0 }}>{capsule.summary}</p>}

      {capsule?.doctor?.length ? (
        <div className="mobile-doctor">
          {capsule.doctor.map((d) => {
            const ok = view?.doctor?.[d.id];
            return <span key={d.id} title={`${ok ? "present" : "missing"} · probe: ${d.probe}`} className={`mobile-chip ${ok ? "ok" : "warn"}`}>{ok ? <Check size={12} /> : "!"} {d.label}</span>;
          })}
          {(capsule.doctor ?? []).some((d) => view?.doctor?.[d.id] === false) && (
            <Button kind="btn" variant="primary" autoPending className="doctor-fix" disabled={prov?.state === "running"} onClick={provision}>
              <Sparkles size={13} /> {prov?.state === "running" ? "Diagnosing…" : "Fix with AI"}
            </Button>
          )}
        </div>
      ) : null}
      {prov && (prov.state === "running" || prov.state === "error") && prov.output && (
        <details className="mobile-log" open>
          <summary><ChevronDown size={13} /> Provisioning agent</summary>
          <pre className="log-pre">{prov.output}</pre>
        </details>
      )}

      {pending.map((c) => <ConsentCard key={c.id} consent={c} onApprove={() => grant(c)} />)}

      <div className="cockpit-actions">
        {(capsule?.actions ?? []).map((a) => {
          const gated = !!a.consent && !grants.has(a.consent);

          // Long-running service: Start/Stop + captured URL + embedded live preview.
          if (a.service) {
            const s = svc[a.id] ?? view?.services?.[a.id] ?? { state: "stopped", url: null };
            const on = s.state === "live" || s.state === "starting";
            return (
              <div key={a.id} className="cockpit-action">
                <div className="cockpit-action-head">
                  {on ? (
                    <Button kind="btn" variant="danger-soft" autoPending onClick={() => stopSvc(a)}>
                      <Square size={13} /> Stop {a.label}
                    </Button>
                  ) : (
                    <Button kind="btn" variant={a.primary ? "primary" : undefined} autoPending disabled={gated} onClick={() => startSvc(a)}>
                      {capsuleIcon(a.icon)} {a.label}
                    </Button>
                  )}
                  {s.state === "starting" && <span className="cockpit-gate">starting…</span>}
                  {s.url && (
                    <button className="btn" onClick={() => window.open(s.url!, "_blank")}><ExternalLink size={14} /> Open</button>
                  )}
                  {gated && <span className="cockpit-gate">approve “{a.consent}” above first</span>}
                </div>
                {a.description && <p className="cockpit-desc">{a.description}</p>}
                {s.state === "live" && s.url && (
                  <iframe className="cockpit-preview" src={s.url} title={a.label} />
                )}
                {(s.state === "starting" || s.state === "error") && svcOut[a.id] && (
                  <details className="mobile-log" open>
                    <summary><ChevronDown size={13} /> Server log</summary>
                    <pre className="log-pre">{svcOut[a.id]}</pre>
                  </details>
                )}
                {judgeUI(a)}
              </div>
            );
          }

          const rs = view?.runs?.[a.id];
          const running = busy === a.id || rs?.state === "running";
          const out = logs[a.id] ?? rs?.output ?? "";
          return (
            <div key={a.id} className="cockpit-action">
              <div className="cockpit-action-head">
                <Button kind="btn" variant={a.primary ? "primary" : undefined} autoPending
                  disabled={running || gated} onClick={() => runAction(a)}>
                  {capsuleIcon(a.icon)} {running ? `${a.label}…` : a.label}
                </Button>
                {a.surface === "preview" && a.url && (
                  <button className="btn" onClick={() => window.open(a.url!.replace("${lan}", lanBase), "_blank")}>
                    <Eye size={14} /> Open
                  </button>
                )}
                {rs?.state === "error" && !running && (
                  <Button kind="btn" variant="primary" autoPending onClick={() => fixAction(a)}>
                    <Sparkles size={14} /> Ask AI to fix
                  </Button>
                )}
                {gated && <span className="cockpit-gate">approve “{a.consent}” above first</span>}
              </div>
              {a.description && <p className="cockpit-desc">{a.description}</p>}

              {a.surface === "device-install" && rs?.artifactReady && (
                <DeviceInstall action={a} devices={view?.devices?.[a.id] ?? []} lanBase={lanBase} />
              )}

              {out && (
                <details className="mobile-log" open={openLog[a.id] ?? false}
                  onToggle={(e) => setOpenLog((o) => ({ ...o, [a.id]: (e.currentTarget as HTMLDetailsElement).open }))}>
                  <summary><ChevronDown size={13} /> Output</summary>
                  <pre className="log-pre">{out}</pre>
                </details>
              )}
              {judgeUI(a)}
            </div>
          );
        })}
      </div>

      {(capsule?.panels ?? []).length > 0 && (
        <div className="cockpit-panels">
          {capsule!.panels!.map((p) => <PanelCard key={p.id} panel={p} />)}
        </div>
      )}

      {(granted.length > 0 || capsule) && (
        <div className="cockpit-granted">
          {granted.map((c) => <span key={c.id} className="mobile-chip ok"><Check size={12} /> {c.title}</span>)}
          {capsule && (
            <button className="btn ghost cockpit-regen" title="Re-run the onboarding agent to regenerate this capsule"
              disabled={gen?.state === "running"} onClick={generate}>
              <Sparkles size={13} /> {gen?.state === "running" ? "Regenerating…" : "Regenerate"}
            </button>
          )}
        </div>
      )}

      {capsule && (
        <div className="cockpit-chat">
          {draft && (
            <div className="chat-draft">
              <div className="chat-draft-head"><Sparkles size={14} /> Proposed edit — review then apply</div>
              <pre className="chat-diff">
                {draft.filter((l) => l.t !== "ctx").length === 0
                  ? <span className="dl-ctx">No change.</span>
                  : draft.map((l, i) => (
                    <div key={i} className={`dl-${l.t}`}>{l.t === "add" ? "+" : l.t === "del" ? "-" : " "} {l.s}</div>
                  ))}
              </pre>
              <div className="card-actions">
                <Button kind="btn" variant="primary" autoPending onClick={applyChat}><Check size={14} /> Apply</Button>
                <button className="btn ghost" onClick={discardChat}><X size={14} /> Discard</button>
              </div>
            </div>
          )}
          <div className="chat-row">
            <input className="chat-input" value={chatMsg} placeholder="Edit the cockpit in plain English — e.g. “add a lint action” or “dev server is on port 3000”"
              onChange={(e) => setChatMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !chatBusy) void sendChat(); }} disabled={chatBusy} />
            <Button kind="btn" variant="primary" autoPending disabled={chatBusy || !chatMsg.trim()} onClick={sendChat}>
              <Sparkles size={14} /> {chatBusy ? "Editing…" : "Edit"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------- Repo modal --------------------------------- */

export interface TreeNode { name: string; path: string; isFile: boolean; children: Map<string, TreeNode> }

/** Fold flat repo paths ("src/components/Nav.tsx") into a nested folder tree. */
export function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), isFile, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Folders first, then files; alphabetical within each. */
export function sortedEntries(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1);
}

export function TreeFolder(
  { node, depth, onOpen, activePath }:
  { node: TreeNode; depth: number; onOpen: (p: string) => void; activePath: string | null },
): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button className="tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tree-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="tree-ic" aria-hidden="true">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open && sortedEntries(node).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={depth + 1} onOpen={onOpen} activePath={activePath} />)}
    </>
  );
}

/** The repo files as a collapsible folder tree. */
export function FileTree({ paths, onOpen, activePath }: { paths: string[]; onOpen: (p: string) => void; activePath: string | null }): JSX.Element {
  const root = buildFileTree(paths);
  return (
    <div className="tree">
      {sortedEntries(root).map((e) => e.isFile
        ? <button key={e.path} className={`tree-file${activePath === e.path ? " on" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onOpen(e.path)}>
            <span className="tree-ic" aria-hidden="true"><FileText size={14} /></span><span className="tree-name">{e.name}</span>
          </button>
        : <TreeFolder key={e.path} node={e} depth={0} onOpen={onOpen} activePath={activePath} />)}
    </div>
  );
}

export function RepoModal(
  { onClose, initialFile }: { onClose: () => void; initialFile?: string },
): JSX.Element {
  const repo = repoPath();
  const [tab, setTab] = useState<"files" | "history">("files");
  const [files, setFiles] = useState<string[]>([]);
  const [commits, setCommits] = useState<Array<{ hash: string; date: string; author: string; subject: string }>>([]);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [mainView, setMainView] = useState<ReactNode>(<p className="hint">Pick a file to preview it, or a commit to see its diff.</p>);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void repoGet<{ branches: string[]; current: string }>("branches").then(setBranches).catch(() => {});
    void repoGet<{ files: string[] }>("tree").then((r) => setFiles(r.files)).catch(() => {});
    // Opened from a hotspot row (or any deep link): preview that file straight away.
    if (initialFile) void openFile(initialFile);
  }, []);
  useEffect(() => {
    if (tab === "history") void repoGet<{ commits: typeof commits }>("log").then((r) => setCommits(r.commits)).catch(() => {});
  }, [tab]);

  if (!repo) return <Modal title="Repo" onClose={onClose}><p className="hint">Set a repository path in the New work panel first.</p></Modal>;

  const openFile = async (path: string): Promise<void> => {
    setActivePath(path);
    try {
      const { content } = await repoGet<{ content: string }>("file", { path });
      setMainView(
        <>
          <div className="repo-file-bar"><span className="card-title">{path}</span>
            <button className="btn ghost" onClick={() => { window.location.href = `vscode://file/${repo.replace(/\\/g, "/")}/${path}`; }}>Open in IDE</button></div>
          <CodeBlock content={content} path={path} />
        </>,
      );
    } catch (err) { toast(String(err), true); }
  };
  const openDiff = async (hash: string): Promise<void> => {
    const { diff } = await repoGet<{ diff: string }>("diff", { commit: hash });
    setMainView(<><div className="repo-file-bar">Commit {hash}</div><Diff text={diff} /></>);
  };

  return (
    <Modal title={`Repo — ${repo.split(/[\\/]/).pop()}`} onClose={onClose} wide>
      <div className="repo-toolbar">
        <Select value={branches.current} ariaLabel="Branch" minWidth={160}
          options={branches.branches.map((b) => ({ value: b, label: b }))}
          onChange={async (v) => {
            try { await postJSON("/api/repo/switch", { path: repo, branch: v }); toast(`Now on ${v}.`);
              const r = await repoGet<{ branches: string[]; current: string }>("branches"); setBranches(r); }
            catch (err) { toast(String(err), true); }
          }} />
        <div className="repo-tabs">
          <button className={`btn link${tab === "files" ? " on" : ""}`} onClick={() => setTab("files")}>Files</button>
          <button className={`btn link${tab === "history" ? " on" : ""}`} onClick={() => setTab("history")}>History</button>
        </div>
      </div>
      <div className="repo-body">
        <div className="repo-side">
          {tab === "files"
            ? <FileTree paths={files} onOpen={(p) => void openFile(p)} activePath={activePath} />
            : commits.map((c) => (
              <button key={c.hash} className="commit-row" onClick={() => void openDiff(c.hash)}>
                <div className="commit-subject">{c.subject}</div>
                <div className="commit-meta">{c.hash} · {c.author} · {c.date}</div>
              </button>
            ))}
        </div>
        <div className="repo-main">{mainView}</div>
      </div>
    </Modal>
  );
}


/** A whole file preview with line numbers and syntax highlighting. */
export function CodeBlock({ content, path }: { content: string; path: string }): JSX.Element {
  const lang = langFromPath(path);
  return (
    <pre className="code-pre">
      {content.split("\n").map((ln, i) => (
        <div key={i} className="code-line">
          <span className="code-gutter">{i + 1}</span>
          <span className="code-text"><CodeLine code={ln} lang={lang} /></span>
        </div>
      ))}
    </pre>
  );
}



/* --------------------------------- pull requests + branches --------------------------------- */

interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  isDraft: boolean;
}

/**
 * Closes the PR-mode loop inside Warden: lists the repo's open PRs and merges or
 * closes them from the board (via `gh`), instead of sending you to github.com.
 * Also shows the branch list. Resolves the repo from the current workspace, so it
 * works right after opening a project (repoPath() may still be empty then).
 */
export function PullRequestsModal({ ws, onClose }: { ws: string; onClose: () => void }): JSX.Element {
  const [repo, setRepo] = useState("");
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [branches, setBranches] = useState<{ list: string[]; current: string }>({ list: [], current: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [bBusy, setBBusy] = useState<string | null>(null); // branch name being acted on, or "__new__"

  const load = async (r: string): Promise<void> => {
    try {
      const p = await fetchJSON<{ prs?: PullRequest[]; error?: string }>(
        `/api/prs?repo=${encodeURIComponent(r)}`,
      );
      setPrs(p.prs ?? []);
      setErr(p.error ?? "");
    } catch { setPrs([]); setErr("could not reach the server"); }
    try {
      const b = await fetchJSON<{ branches?: string[]; current?: string }>(
        `/api/repo/branches?repo=${encodeURIComponent(r)}`,
      );
      setBranches({ list: b.branches ?? [], current: b.current ?? "" });
    } catch { /* branches are secondary */ }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let r = repoPath();
      if (!r) {
        try {
          const list = await fetchJSON<{ workspaces?: Array<{ name: string; repo: string | null }> }>(
            "/api/workspaces",
          );
          r = (list.workspaces ?? []).find((w) => w.name === ws)?.repo ?? "";
        } catch { /* */ }
      }
      if (!live) return;
      setRepo(r);
      if (r) await load(r);
      else { setPrs([]); setErr("no repository set for this project"); }
    })();
    return () => { live = false; };
  }, [ws]);

  const act = async (n: number, kind: "merge" | "close"): Promise<void> => {
    setBusy(n);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>(`/api/prs/${kind}`, { repo, number: n });
      if (r.ok) { toast(`PR #${n} ${kind === "merge" ? "merged" : "closed"}.`); await load(repo); }
      else toast(r.error || `could not ${kind} PR #${n}`, true);
    } catch (e) { toast(String(e), true); }
    finally { setBusy(null); }
  };

  // Branch actions — all guarded server-side (no switch/create/delete mid-run,
  // no deleting main or the current branch). bBusy locks the whole list.
  const switchTo = async (b: string): Promise<void> => {
    if (b === branches.current || bBusy) return;
    setBBusy(b);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/switch", { path: repo, branch: b });
      if (r.ok) { toast(`Now on ${b}.`); await load(repo); } else toast(r.error || "couldn't switch", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };
  const delBranch = async (b: string): Promise<void> => {
    setBBusy(b);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/branch/delete", { path: repo, branch: b });
      if (r.ok) { toast(`Deleted ${b}.`); await load(repo); } else toast(r.error || "couldn't delete", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };
  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim();
    if (!name || bBusy) return;
    setBBusy("__new__");
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/repo/branch/create", { path: repo, branch: name });
      if (r.ok) { toast(`Created ${name}.`); setNewBranch(""); await load(repo); } else toast(r.error || "couldn't create", true);
    } catch (e) { toast(String(e), true); } finally { setBBusy(null); }
  };

  const mergeable = (m: string): { text: string; cls: string } =>
    m === "MERGEABLE" ? { text: "ready", cls: "ok" }
      : m === "CONFLICTING" ? { text: "conflicts", cls: "bad" }
        : { text: "checking…", cls: "warn" };

  return (
    <Modal title="Pull requests" onClose={onClose} wide>
      {err && <p className="pr-note">{err}</p>}
      {prs === null ? (
        <p className="pr-note">Loading…</p>
      ) : prs.length === 0 ? (
        !err && <p className="pr-note">No open pull requests. When a run lands in PR mode, they show up here.</p>
      ) : (
        <ul className="pr-list">
          {prs.map((pr) => {
            const m = mergeable(pr.mergeable);
            return (
              <li key={pr.number} className="pr-row">
                <div className="pr-main">
                  <a className="pr-num" href={pr.url} target="_blank" rel="noreferrer">
                    #{pr.number} <ExternalLink size={11} />
                  </a>
                  <span className="pr-title">{pr.title}</span>
                </div>
                <div className="pr-meta">
                  <span className="pr-branch"><GitBranch size={11} /> {pr.headRefName} → {pr.baseRefName}</span>
                  <span className={`pr-mergeable ${m.cls}`}>{pr.isDraft ? "draft" : m.text}</span>
                </div>
                <div className="pr-actions">
                  <Button kind="btn" variant="primary" pending={busy === pr.number}
                    disabled={pr.isDraft || pr.mergeable === "CONFLICTING" || busy !== null}
                    onClick={() => act(pr.number, "merge")}>
                    <GitMerge size={13} /> Merge
                  </Button>
                  <ConfirmButton label="Close" confirm="Close PR?" onConfirm={() => act(pr.number, "close")} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="pr-branches">
        <div className="pr-branches-head"><GitBranch size={12} /> Branches</div>
        <div className="branch-new">
          <input className="branch-input" placeholder="New branch name…" value={newBranch}
            aria-label="New branch name"
            onChange={(e) => setNewBranch(e.currentTarget.value.replace(/[^\w./-]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") void createBranch(); }} />
          <Button kind="btn" pending={bBusy === "__new__"} disabled={!newBranch.trim() || bBusy !== null}
            onClick={createBranch}><Plus size={13} /> Create</Button>
        </div>
        {branches.list.length === 0 ? (
          <span className="pr-note">—</span>
        ) : (
          <ul className="branch-list">
            {branches.list.map((b) => {
              const cur = b === branches.current;
              const locked = b === "main" || b === "master";
              return (
                <li key={b} className={cur ? "cur" : ""}>
                  <button className="branch-name" disabled={cur || bBusy !== null}
                    title={cur ? "Current branch" : `Switch to ${b}`} onClick={() => switchTo(b)}>
                    {b}{cur ? " · current" : ""}
                  </button>
                  {!cur && !locked && (
                    <ConfirmButton label={<Trash2 size={13} />} confirm="Delete?"
                      plain onConfirm={() => delBranch(b)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------------- autopilot loop --------------------------------- */

interface LoopState {
  state: string; // idle | running | done | error
  name?: string; objective?: string; integ?: string; base?: string;
  budget?: number; maxIterations?: number; iteration?: number; spent?: number;
  stop?: string; accepted?: boolean; pr?: string;
}

/**
 * The opt-in autopilot loop: give it an objective + an executable acceptance
 * check, and it plans->runs on an integration branch (main untouched) under a
 * hard budget cap, opening a single PR at the end. Three states — create / live /
 * finished — driven by GET /api/loop. Never lets you start without a cap.
 */
export function AutopilotModal({ ws, onClose }: { ws: string; onClose: () => void }): JSX.Element {
  const [repo, setRepo] = useState("");
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [creating, setCreating] = useState(false); // force the create form after a finished loop
  const [mode, setMode] = useState("explicit"); // explicit | supervisor | self | backlog
  const [objective, setObjective] = useState("");
  const att = useAttachments();
  const [accept, setAccept] = useState("");
  const [budget, setBudget] = useState("10");
  const [maxIter, setMaxIter] = useState("5");
  const [drafting, setDrafting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [steerObj, setSteerObj] = useState("");   // live re-steer draft
  const [steering, setSteering] = useState(false);
  const steerDirty = useRef(false);
  const [costHint, setCostHint] = useState<number | null>(null);
  const every = useManagedInterval();

  const refresh = async (): Promise<LoopState | null> => {
    try {
      const l = await fetchJSON<LoopState>(`/api/loop?ws=${encodeURIComponent(ws)}`);
      setLoop(l);
      return l;
    } catch { return null; }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let r = repoPath();
      if (!r) {
        try {
          const list = await fetchJSON<{ workspaces?: Array<{ name: string; repo: string | null }> }>(
            "/api/workspaces",
          );
          r = (list.workspaces ?? []).find((w) => w.name === ws)?.repo ?? "";
        } catch { /* */ }
      }
      if (live) setRepo(r);
      await refresh();
      try {
        const f = await fetchJSON<{ history?: { medianUsdPerTicket?: number } }>(
          `/api/forecast?ws=${encodeURIComponent(ws)}`);
        if (live) setCostHint(f.history?.medianUsdPerTicket ?? null);
      } catch { /* the cost hint is optional */ }
    })();
    return () => { live = false; };
  }, [ws]);

  // Keep the re-steer draft in sync with the live objective until the operator edits it.
  useEffect(() => { if (!steerDirty.current) setSteerObj(loop?.objective ?? ""); }, [loop?.objective]);

  // Poll while a loop is live so the gauge and iteration keep up.
  useEffect(() => {
    every((stop) => { if (loop?.state !== "running") stop(); else void refresh(); }, 2500);
  }, [loop?.state]);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const r = await postJSON<{ ok?: boolean; objective?: string; accept?: string; error?: string }>(
        "/api/loop/draft", { repo });
      if (r.ok) { setObjective(r.objective ?? ""); setAccept(r.accept ?? ""); }
      else toast(r.error || "could not draft an objective", true);
    } catch (e) { toast(String(e), true); }
    finally { setDrafting(false); }
  };

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/loop/start", {
        mode, objective: objective + att.refs(), accept, repo,
        budget: Number(budget), maxIterations: Number(maxIter),
      });
      if (r.ok) { att.clear(); toast("Autopilot started."); setCreating(false); await refresh(); }
      else toast(r.error || "could not start the loop", true);
    } catch (e) { toast(String(e), true); }
    finally { setStarting(false); }
  };

  const stop = async (): Promise<void> => {
    try { await postJSON("/api/loop/stop", {}); toast("Autopilot stopped."); await refresh(); }
    catch (e) { toast(String(e), true); }
  };

  const steer = async (): Promise<void> => {
    setSteering(true);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string }>("/api/loop/steer",
        { objective: steerObj });
      if (r.ok) { toast("Re-steered — applies next round."); steerDirty.current = false; await refresh(); }
      else toast(r.error || "could not re-steer", true);
    } catch (e) { toast(String(e), true); }
    finally { setSteering(false); }
  };

  const running = loop?.state === "running";
  const finished = !running && !creating && !!loop?.stop;

  const MODES: Array<{ id: string; Icon: LucideIcon; title: string; desc: string }> = [
    { id: "explicit", Icon: Flag, title: "Objective", desc: "Pursue a goal until an acceptance check passes." },
    { id: "supervisor", Icon: Sparkles, title: "Mission", desc: "A supervisor turns a mission into a step each round." },
    { id: "self", Icon: InfinityIcon, title: "Auto-improve", desc: "Split the largest files until none stay oversized." },
    { id: "backlog", Icon: ListChecks, title: "Run backlog", desc: "Work through this project's backlog, hands-off." },
  ];
  const needObj = (mode === "explicit" || mode === "supervisor") && !objective.trim();
  const noCap = !(Number(budget) > 0);
  const capN = Number(budget) || 0;

  // Live spend ring (running state): the arc fills toward the cap, warming to
  // amber then red as it approaches.
  const spent = loop?.spent ?? 0;
  const cap = loop?.budget ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const R = 30;
  const CIRC = 2 * Math.PI * R;
  const ringColor = pct >= 95 ? "var(--st-failed-dot)" : pct >= 75 ? "var(--st-blocked-dot)" : "var(--accent)";

  return (
    <Modal title="Autopilot" onClose={onClose} wide>
      {running ? (
        <div className="loop-live">
          <div className="loop-live-top">
            <div className="loop-ring-wrap">
              <svg className="loop-ring" viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
                <circle className="loop-ring-track" cx="36" cy="36" r={R} />
                <circle className="loop-ring-arc" cx="36" cy="36" r={R}
                  style={{ stroke: ringColor, strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
              </svg>
              <div className="loop-ring-label">
                <span className="loop-ring-spent">${spent.toFixed(2)}</span>
                <span className="loop-ring-cap">of ${cap.toFixed(2)}</span>
              </div>
            </div>
            <div className="loop-live-head">
              <div className="loop-headline"><span className="loop-pulse" aria-hidden="true" /> Autopilot running</div>
              <div className="loop-substat">Iteration {loop?.iteration ?? "…"} · <span className="mono">{loop?.integ}</span></div>
              <div className="loop-safety">
                <span><GitBranch size={12} /> main untouched</span>
                <span><Lock size={12} /> capped at ${cap.toFixed(0)}</span>
              </div>
            </div>
          </div>

          {loop?.objective ? (
            <div className="loop-steer">
              <label className="work-label">Steer the objective — live</label>
              <textarea className="input" rows={3} value={steerObj}
                onChange={(e) => { steerDirty.current = true; setSteerObj(e.target.value); }} />
              <div className="loop-steer-row">
                <Button kind="btn" pending={steering}
                  disabled={steering || !steerObj.trim() || steerObj.trim() === (loop?.objective ?? "").trim()}
                  onClick={steer}><Send size={13} /> Re-steer</Button>
                <span className="loop-note">applied at the start of the next round — no restart</span>
              </div>
            </div>
          ) : (
            <p className="loop-note">Working autonomously — merges land on the integration branch; a PR opens when it finishes.</p>
          )}

          <ConfirmButton label="Stop autopilot" confirm="Stop now?" onConfirm={stop} />
        </div>
      ) : finished ? (
        <div className="loop-done">
          <div className={`loop-done-badge ${loop?.stop === "success" ? "ok" : "warn"}`}>
            {loop?.stop === "success" ? <Check size={22} /> : <CircleDot size={22} />}
          </div>
          <div className="loop-headline">
            {loop?.stop === "success" ? "Objective reached" : `Stopped — ${loop?.stop}`}
          </div>
          <div className="loop-done-stats">
            <div><span className="loop-stat-n">${(loop?.spent ?? 0).toFixed(2)}</span><span className="loop-stat-l">spent of ${(loop?.budget ?? 0).toFixed(2)}</span></div>
            <div><span className="loop-stat-n">{loop?.accepted ? "Yes" : "No"}</span><span className="loop-stat-l">objective met</span></div>
          </div>
          {loop?.pr
            ? <a className="btn primary loop-cta" href={loop.pr} target="_blank" rel="noreferrer"><GitMerge size={14} /> Review &amp; merge the PR</a>
            : <p className="loop-note">Work is on <span className="mono">{loop?.integ}</span> — test it, then merge into {loop?.base ?? "main"}.</p>}
          <Button kind="btn" onClick={() => { setCreating(true); setLoop({ state: "idle" }); }}>Start a new loop</Button>
        </div>
      ) : (
        <div className="loop-form">
          <div className="loop-cards" role="radiogroup" aria-label="Autopilot mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id}
                className={`loop-card${mode === m.id ? " on" : ""}`} onClick={() => setMode(m.id)}>
                <m.Icon size={18} />
                <span className="loop-card-title">{m.title}</span>
                <span className="loop-card-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          <div className="loop-fields">
            {(mode === "explicit" || mode === "supervisor") && (
              <>
                <label className="work-label">{mode === "supervisor" ? "Mission" : "Objective"}</label>
                <textarea className="input loop-obj-input" rows={4}
                  placeholder={mode === "supervisor"
                    ? "Describe the mission — the supervisor breaks it into a concrete step each round."
                    : "What should the autopilot achieve? Be specific about what “done” looks like."}
                  value={objective} onChange={(e) => setObjective(e.target.value)}
                  onPaste={att.paste} onDrop={att.drop} onDragOver={(e) => e.preventDefault()} />
                <button type="button" className="loop-draft" disabled={!repo || drafting} onClick={() => void draft()}>
                  <Sparkles size={13} /> {drafting ? "Reading the repo…" : "Draft with AI"}
                </button>
                <AttachStrip items={att.items} onRemove={att.remove} />
              </>
            )}
            {mode === "explicit" && (
              <>
                <label className="work-label">Acceptance check <span className="loop-faint">— a command that exits 0 when done</span></label>
                <input className="input mono" placeholder="e.g. npm --prefix dashboard test"
                  value={accept} onChange={(e) => setAccept(e.target.value)} />
              </>
            )}
            {mode === "self" && (
              <p className="loop-mode-note"><InfinityIcon size={14} /> Each round splits the repo's largest file into modules, until none stay oversized. No objective needed.</p>
            )}
            {mode === "backlog" && (
              <p className="loop-mode-note"><ListChecks size={14} /> Works through this project's backlog on an integration branch — no planning spend.</p>
            )}
          </div>

          <div className="loop-safety loop-safety-strip">
            <span><GitBranch size={13} /> Isolated branch</span>
            <span><Lock size={13} /> Main untouched</span>
            <span><ShieldCheck size={13} /> Stops at ${capN || "—"}</span>
            <span><Check size={13} /> You review the PR</span>
          </div>

          <div className="loop-caps">
            <div>
              <label className="work-label">Budget cap ($)</label>
              <input className="input" type="number" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
              <span className="loop-faint">hard stop</span>
            </div>
            <div>
              <label className="work-label">Max iterations</label>
              <input className="input" type="number" min="1" value={maxIter} onChange={(e) => setMaxIter(e.target.value)} />
              <span className="loop-faint">rounds before it halts</span>
            </div>
          </div>
          {costHint != null && costHint > 0 && (
            <p className="loop-note">Your recent runs averaged <strong>~${costHint.toFixed(2)}/ticket</strong> — size the cap to how far you want it to go.</p>
          )}

          <div className="loop-launch">
            <Button kind="btn" variant="primary" className="loop-cta" pending={starting}
              disabled={needObj || noCap || !repo || starting} onClick={start}>
              <Play size={14} /> Start autopilot{capN ? ` · capped at $${capN}` : ""}
            </Button>
            {(needObj || noCap) && (
              <span className="loop-blocked">{noCap ? "Add a budget cap to start." : "Describe an objective to start."}</span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
