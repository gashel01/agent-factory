import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { CapsuleAction, CapsuleConsent, CapsulePanel, CapsuleView } from "./types.js";
import { api, fetchJSON, postJSON } from "./api.js";
import { Button, toast, useManagedInterval } from "./core.js";
import { NetInfo } from "./screens.js";
import { Modal } from "./widgets.js";
import {
  Check, ChevronDown, Eye, ExternalLink, Sparkles, Square, X,
} from "./icons.js";
import { ConsentCard, DeviceInstall, PanelCard, capsuleIcon } from "./cockpit.js";

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
                  {gated && <span className="cockpit-gate">approve "{a.consent}" above first</span>}
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
                {gated && <span className="cockpit-gate">approve "{a.consent}" above first</span>}
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
            <input className="chat-input" value={chatMsg} placeholder="Edit the cockpit in plain English — e.g. "add a lint action" or "dev server is on port 3000""
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
