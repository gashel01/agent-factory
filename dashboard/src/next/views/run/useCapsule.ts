/** The project cockpit's state and verbs — the logic of the classic
 *  cockpit-core.tsx, unchanged in its requests, bodies, polling cadence and
 *  toasts, lifted out of the markup. The capsule (capsule.json) describes the
 *  project's actions, services, panels, toolchain checks and consents; the
 *  server runs them. Everything here is one GET /api/capsule plus a status poll
 *  per thing in flight. */

import { useCallback, useEffect, useState } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import type { DiffLine } from "../../../capsule-core.js";
import { toast } from "../../../core.js";
import type { NetInfo } from "../../../api-shapes.js";
import type { CapsuleAction, CapsuleConsent, CapsuleView } from "../../../types.js";
import { plainError } from "../repo/errors.js";
import { usePollers } from "./pollers.js";

export interface AgentJob { state: string; output: string }
export interface ServiceState { state: string; url: string | null }
export interface JudgeState { state: string; verdict: string | null; confidence: number | null; reasons: string[]; hasShot: boolean }

const ACTION_POLL_MS = 1200;
/** A refused request (already running, unknown action, no repository…) in plain words. */
const failed = (e: unknown): void => toast(plainError(e, "Warden couldn't do that — try again.").text, true);
const AGENT_POLL_MS = 1500;

export interface Cockpit {
  view: CapsuleView | null;
  loadError: string;
  lanBase: string;
  /** Live output per action (fresher than view.runs while polling). */
  logs: Record<string, string>;
  running: Set<string>;
  gen: AgentJob | null;
  prov: AgentJob | null;
  svc: Record<string, ServiceState>;
  svcOut: Record<string, string>;
  judge: Record<string, JudgeState>;
  draft: DiffLine[] | null;
  chatBusy: boolean;
  refresh: () => void;
  runAction: (a: CapsuleAction) => Promise<void>;
  fixAction: (a: CapsuleAction) => Promise<void>;
  startSvc: (a: CapsuleAction) => Promise<void>;
  stopSvc: (a: CapsuleAction) => Promise<void>;
  runJudge: (a: CapsuleAction) => Promise<void>;
  grant: (c: CapsuleConsent) => Promise<void>;
  generate: () => Promise<void>;
  provision: () => Promise<void>;
  sendChat: (message: string) => Promise<boolean>;
  applyChat: () => Promise<void>;
  discardChat: () => Promise<void>;
}

export function useCapsule(ws: string): Cockpit {
  const [view, setView] = useState<CapsuleView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [net, setNet] = useState<NetInfo | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [gen, setGen] = useState<AgentJob | null>(null);
  const [prov, setProv] = useState<AgentJob | null>(null);
  const [svc, setSvc] = useState<Record<string, ServiceState>>({});
  const [svcOut, setSvcOut] = useState<Record<string, string>>({});
  const [judge, setJudge] = useState<Record<string, JudgeState>>({});
  const [draft, setDraft] = useState<DiffLine[] | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const poll = usePollers();

  const refresh = useCallback((): void => {
    fetchJSON<CapsuleView>("/api/capsule")
      .then((v) => { setView(v); setLoadError(""); })
      .catch(() => setLoadError("Couldn't load this project's cockpit — is Warden still running?"));
  }, []);
  const loadDraft = (): void => {
    void fetchJSON<{ has: boolean; diff: DiffLine[] }>("/api/capsule/chat/draft")
      .then((d) => setDraft(d.has ? d.diff : null)).catch(() => { /* no draft */ });
  };
  useEffect(() => {
    setView(null); setLogs({}); setRunning(new Set()); setSvc({}); setSvcOut({}); setJudge({}); setGen(null); setProv(null);
    refresh();
    loadDraft();
    void fetchJSON<NetInfo>("/api/netinfo").then(setNet).catch(() => { /* no LAN info: QR hidden */ });
  }, [ws]);

  const setRun = (id: string, on: boolean): void =>
    setRunning((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  /** Poll one action's status until it settles, then report with `settled`. */
  const watchAction = (a: CapsuleAction, ms: number, settled: (ok: boolean) => void): void => {
    setRun(a.id, true);
    poll(`action:${a.id}`, async (stop) => {
      const s = await fetchJSON<AgentJob>(`/api/capsule/status?id=${encodeURIComponent(a.id)}`);
      setLogs((l) => ({ ...l, [a.id]: s.output }));
      if (s.state === "ok" || s.state === "error") {
        stop(); setRun(a.id, false); refresh(); settled(s.state === "ok");
      }
    }, ms);
  };

  const runAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/action", { id: a.id }); } catch (e) { failed(e); return; }
    watchAction(a, ACTION_POLL_MS, (ok) => toast(ok ? `${a.label} — done.` : `${a.label} failed — see the output.`, !ok));
  };
  const fixAction = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/fix", { id: a.id }); } catch (e) { failed(e); return; }
    watchAction(a, AGENT_POLL_MS, (ok) => toast(ok ? `${a.label} fixed — it passes now.` : `Couldn't fix ${a.label} — see the output.`, !ok));
  };

  const startSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service", { id: a.id }); } catch (e) { failed(e); return; }
    setSvc((m) => ({ ...m, [a.id]: { state: "starting", url: null } }));
    poll(`svc:${a.id}`, async (stop) => {
      const s = await fetchJSON<{ state: string; url: string | null; output: string }>(`/api/capsule/service?id=${encodeURIComponent(a.id)}`);
      setSvc((m) => ({ ...m, [a.id]: { state: s.state, url: s.url } }));
      setSvcOut((o) => ({ ...o, [a.id]: s.output }));
      if (s.state === "live") { stop(); toast(`${a.label} is live.`); }
      else if (s.state === "error" || s.state === "stopped") { stop(); if (s.state === "error") toast(`${a.label} failed — see output.`, true); }
    }, ACTION_POLL_MS);
  };
  const stopSvc = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/service/stop", { id: a.id }); } catch (e) { failed(e); }
    setSvc((m) => ({ ...m, [a.id]: { state: "stopped", url: null } }));
  };

  const runJudge = async (a: CapsuleAction): Promise<void> => {
    try { await postJSON("/api/capsule/judge", { id: a.id }); } catch (e) { failed(e); return; }
    setJudge((m) => ({ ...m, [a.id]: { state: "running", verdict: null, confidence: null, reasons: [], hasShot: false } }));
    poll(`judge:${a.id}`, async (stop) => {
      const s = await fetchJSON<JudgeState>(`/api/capsule/judge?id=${encodeURIComponent(a.id)}`);
      setJudge((m) => ({ ...m, [a.id]: s }));
      if (s.state === "done" || s.state === "error") {
        stop();
        if (s.state === "done") toast(`${a.label}: ${s.verdict === "pass" ? "passes" : "fails"} the behavioral check.`, s.verdict !== "pass");
        else toast(`Judge failed on ${a.label}.`, true);
      }
    }, AGENT_POLL_MS);
  };

  const grant = async (c: CapsuleConsent): Promise<void> => {
    try { await postJSON("/api/capsule/consent", { id: c.id }); toast(`${c.title} — provisioned.`); refresh(); }
    catch (e) { failed(e); }
  };

  /** Start an agent job (__generate__ / __provision__) and follow it. */
  const agentJob = async (url: string, id: string, set: (j: AgentJob) => void, ok: string, fail: string): Promise<void> => {
    try { await postJSON(url, {}); } catch (e) { failed(e); return; }
    set({ state: "running", output: "" });
    poll(id, async (stop) => {
      const s = await fetchJSON<AgentJob>(`/api/capsule/status?id=${id}`);
      set(s);
      if (s.state === "ok" || s.state === "error") {
        stop();
        if (s.state === "ok") { toast(ok); refresh(); } else toast(fail, true);
      }
    }, AGENT_POLL_MS);
  };
  const generate = (): Promise<void> =>
    agentJob("/api/capsule/generate", "__generate__", setGen, "Cockpit generated — review it.", "Generation failed — see the output.");
  const provision = (): Promise<void> =>
    agentJob("/api/capsule/provision", "__provision__", setProv, "Install plan ready — review the facts and approve.", "Provisioning diagnosis failed — see the output.");

  const sendChat = async (message: string): Promise<boolean> => {
    if (!message.trim()) return false;
    try { await postJSON("/api/capsule/chat", { message: message.trim() }); } catch (e) { failed(e); return false; }
    setChatBusy(true);
    poll("__chat__", async (stop) => {
      const s = await fetchJSON<{ state: string }>("/api/capsule/status?id=__chat__");
      if (s.state === "ok" || s.state === "error") {
        stop(); setChatBusy(false);
        if (s.state === "ok") { loadDraft(); toast("Proposed an edit — review the diff."); }
        else toast("Couldn't edit the capsule — try rephrasing.", true);
      }
    }, AGENT_POLL_MS);
    return true;
  };
  const applyChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/apply", {}); setDraft(null); toast("Applied."); refresh(); }
    catch (e) { failed(e); }
  };
  const discardChat = async (): Promise<void> => {
    try { await postJSON("/api/capsule/chat/discard", {}); } catch { /* the draft is dropped locally anyway */ }
    setDraft(null);
  };

  return {
    view, loadError, lanBase: net?.url ?? "", logs, running, gen, prov, svc, svcOut, judge, draft, chatBusy,
    refresh, runAction, fixAction, startSvc, stopSvc, runJudge, grant, generate, provision, sendChat, applyChat, discardChat,
  };
}
