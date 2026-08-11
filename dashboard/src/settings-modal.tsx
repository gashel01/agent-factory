import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { Settings } from "./model.js";
import {
  EFFORT_CHOICES, MODEL_CHOICES, fmtDuration, fmtUsd, generateConfig,
  parseSettings,
} from "./model.js";
import { fetchJSON, getWs, postJSON } from "./api.js";
import {
  Check, FlaskConical, InfinityIcon, Key, Laptop, Lock, ShieldCheck,
} from "./icons.js";
import { Skeleton, WorkspaceInfo, toast, useManagedInterval } from "./core.js";
import { Drawer, Select } from "./widgets.js";
import { RepoTools } from "./work.js";

export interface DockerStatus {
  engine: boolean; image: boolean; proxy: boolean; ready: boolean;
  detail?: string; building?: boolean; buildOk?: boolean | null; buildLog?: string;
}

/** Direct/Sandbox toggle with a live Docker preflight + one-click image build.
 *  Polls /api/docker only while Sandbox is selected, so a Direct project pays nothing. */
export function SandboxControl({ value, onChange }: {
  value: "direct" | "sandbox"; onChange: (v: "direct" | "sandbox") => void;
}): JSX.Element {
  const [st, setSt] = useState<DockerStatus | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (value !== "sandbox") { setSt(null); setErr(false); return; }
    let alive = true;
    const tick = (): void => {
      void fetchJSON<DockerStatus>("/api/docker")
        .then((s) => { if (alive) { setSt(s); setErr(false); } })
        .catch(() => { if (alive) setErr(true); });
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [value]);

  const build = async (): Promise<void> => {
    try { await postJSON("/api/docker/build", {}); toast("Building the sandbox image — runs once (~1–3 min)."); }
    catch (err) { toast(String(err), true); }
  };
  const dot = (ok: boolean) => <span className={`sbx-dot ${ok ? "on" : "off"}`} aria-hidden="true" />;

  return (
    <div className="sbx-control">
      <div className="seg">
        <button className={value !== "sandbox" ? "on" : ""} onClick={() => onChange("direct")}><Laptop size={14} /> Direct</button>
        <button className={value === "sandbox" ? "on" : ""} onClick={() => onChange("sandbox")}><Lock size={14} /> Sandbox</button>
      </div>
      {value === "sandbox" && (
        <div className="sbx-status">
          {!st && err ? (
            <span className="sbx-hint">Couldn't reach the dashboard server to check Docker — is it still running? Retrying…</span>
          ) : !st ? (
            <span className="sbx-line">checking Docker…</span>
          ) : (
            <>
              <span className="sbx-line">{dot(st.engine)} Docker engine {st.engine ? "ready" : "off"}</span>
              <span className="sbx-line">{dot(st.image)} Sandbox image {st.image ? "built" : "missing"}</span>
              {st.engine && st.image ? (
                <span className="sbx-ready"><Check size={13} /> Confined runs ready — only the worktree is visible, egress limited to Anthropic. The proxy auto-starts on your first run.</span>
              ) : st.building ? (
                <span className="sbx-line">building image… {st.buildLog?.split("\n").filter(Boolean).slice(-1)[0] ?? ""}</span>
              ) : !st.engine ? (
                <span className="sbx-hint">{st.detail || "Start Docker Desktop — this refreshes automatically."}</span>
              ) : (
                <button className="btn ghost sm" onClick={() => void build()}>Build sandbox image</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-text"><div className="setting-label">{label}</div><div className="setting-hint">{hint}</div></div>
      {children}
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} className="settings-section">
      <h4 className="settings-section-title">{title}</h4>
      {children}
    </section>
  );
}

export const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: "set-general", label: "General" },
  { id: "set-project", label: "Project & repo" },
  { id: "set-safety", label: "Execution & safety" },
  { id: "set-advanced", label: "Advanced" },
];

export function SettingsModal({ onClose, initialSection }: { onClose: () => void; initialSection?: string }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const validSection = initialSection && SETTINGS_SECTIONS.some((x) => x.id === initialSection) ? initialSection : null;
  const [activeSec, setActiveSec] = useState(validSection ?? SETTINGS_SECTIONS[0]!.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const jumped = useRef(false);
  const pollDoctor = useManagedInterval();
  const set = (patch: Partial<Settings>) => setS((cur) => cur ? { ...cur, ...patch } : cur);

  useEffect(() => {
    void fetchJSON<{ content: string }>("/api/config").then(({ content }) => setS(parseSettings(content)));
    void fetchJSON<{ workspaces: WorkspaceInfo[] }>("/api/workspaces").then(({ workspaces }) => {
      const active = workspaces.find((w) => w.name === getWs()) ?? workspaces[0];
      setRepo(active?.repo ?? "");
    }).catch(() => { /* leave blank */ });
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !s) return;
    const secs = SETTINGS_SECTIONS
      .map((x) => document.getElementById(x.id))
      .filter((el): el is HTMLElement => el !== null);
    const obs = new IntersectionObserver((entries) => {
      const top = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActiveSec(top.target.id);
    }, { root, rootMargin: "0px 0px -70% 0px", threshold: 0 });
    secs.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [s]);

  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
    setActiveSec(id);
  };

  useEffect(() => {
    if (!s || !validSection || jumped.current) return;
    jumped.current = true;
    const id = window.setTimeout(() => jump(validSection), 0);
    return () => window.clearTimeout(id);
  }, [s]);

  const saveRepoPath = async (): Promise<void> => {
    try { await postJSON("/api/repo/path", { path: repo.trim() }); }
    catch (err) { toast(String(err), true); }
  };

  const save = async (): Promise<void> => {
    if (!s) return;
    await fetchJSON("/api/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: generateConfig(s) }),
    });
  };

  const doTest = async (): Promise<void> => {
    try { await save(); await postJSON("/api/doctor", {}); } catch (err) { toast(String(err), true); return; }
    setTesting(true); setTestOut("Testing for real — one tiny agent tries the web and your commands (~30s)…");
    pollDoctor((stop) => {
      void (async () => {
        const st = await fetchJSON<{ doctor: { state: string; output: string } }>("/api/status");
        if (st.doctor.state === "running") return;
        stop(); setTesting(false);
        setTestOut(st.doctor.output.trim() || (st.doctor.state === "error" ? "The check failed — see server logs." : "(no result)"));
      })();
    }, 2000);
  };

  if (!s) return <Drawer title="Settings" wide onClose={onClose}><div className="panel-body"><Skeleton lines={8} /></div></Drawer>;

  const effortChoices = [...EFFORT_CHOICES];
  if (s.effort && !effortChoices.some(([v]) => v === s.effort)) effortChoices.push([s.effort, `${s.effort} (expensive)`]);
  const planChoices: Array<[string, string]> = [["", "Same as coders"], ["haiku", "Haiku (cheapest)"], ["sonnet", "Sonnet"]];
  if (s.planModel && !planChoices.some(([v]) => v === s.planModel)) planChoices.push([s.planModel, s.planModel]);
  const modelChoices = [...MODEL_CHOICES];
  if (s.model && !modelChoices.some(([v]) => v === s.model)) modelChoices.push([s.model, s.model]);

  return (
    <Drawer title="Settings" wide onClose={onClose} foot={
      <>
        <button className="btn ghost" disabled={testing} onClick={() => void doTest()}><FlaskConical size={14} /> Test these settings</button>
        <button className="btn primary" onClick={async () => {
          try { await save(); toast("Saved. Your next run uses these settings."); onClose(); }
          catch (err) { toast(String(err), true); }
        }}>Save</button>
      </>
    }>
      <div className="panel-body settings-form" ref={scrollRef}>
        <p className="settings-intro">Sensible defaults are already set — you can run without changing a thing. Tweak these only if you want to.</p>
        {getWs() && <p className="settings-scope"><ShieldCheck size={13} /> These apply to <b>{getWs()}</b> only — each project keeps its own settings.</p>}
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Jump to a settings section">
            {SETTINGS_SECTIONS.map((sec) => (
              <button key={sec.id} type="button" className={`settings-nav-item${activeSec === sec.id ? " on" : ""}`}
                onClick={() => jump(sec.id)}>{sec.label}</button>
            ))}
          </nav>
          <div className="settings-panes">
            <Section id="set-general" title="General">
              <Row label="Project type" hint="Picks the matching build tools and the default dependency install.">
                <div className="chip-choice">
                  {(["node", "python", "other"] as const).map((v) => (
                    <button key={v} className={`btn choice${s.project === v ? " on" : ""}`}
                      onClick={() => set({ project: v, setupCommands: v === "node" ? "npm install" : v === "python" ? "uv sync" : "" })}>
                      {v === "node" ? "Node / JS" : v === "python" ? "Python" : "Other"}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Coding model" hint="The starting model for every coding agent — cheapest is fine: a ticket that fails verify automatically retries on a stronger tier (haiku → sonnet → opus). A ticket can still pin its own.">
                <Select value={s.model} onChange={(v) => set({ model: v })} ariaLabel="Coding model"
                  options={modelChoices.map(([value, label]) => ({ value, label }))} />
              </Row>
              <Row label="Parallel agents" hint="How many agents work at once. 2 is a calm default on a subscription plan.">
                <input type="number" min="1" className="input num" value={s.slots} onChange={(e) => set({ slots: Math.max(1, Number(e.target.value) || 2) })} />
              </Row>
              <Row label="Review before merge" hint="Approve every change yourself. Finished work waits in &quot;To review&quot; instead of merging on its own.">
                <input type="checkbox" className="switch" checked={s.manualApproval} onChange={(e) => set({ manualApproval: e.target.checked })} />
              </Row>
              <Row label="Run budget (USD)" hint="Stop launching new agents once estimated spend crosses this. Empty = no cap.">
                <input type="number" min="0" step="0.5" className="input num" placeholder="none" value={s.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value.trim() })} />
              </Row>
            </Section>

            <Section id="set-project" title="Project & repository">
              <Row label="Repository path" hint="The git repo your agents work in. New tickets default to it and the planner explores it. Set once per project.">
                <input className="input" placeholder="C:\\path\\to\\your\\repo" value={repo}
                  onChange={(e) => setRepo(e.target.value)} onBlur={() => void saveRepoPath()} />
              </Row>
              <Row label="GitHub" hint="Turn this folder into a git repo, publish it, or flip its visibility. Needs git and the gh CLI logged in.">
                <RepoTools repo={repo} />
              </Row>
              <Row label="Install dependencies" hint="Run in every agent's fresh copy of the repo, before work starts. Comma-separated.">
                <input className="input" value={s.setupCommands} placeholder="npm install" onChange={(e) => set({ setupCommands: e.target.value })} />
              </Row>
            </Section>

            <Section id="set-safety" title="Execution & safety">
              <Row label="Execution mode" hint="Subscription draws from your Claude plan (no real charge; the cost shown is an estimate). API uses the key in your environment and bills real dollars. The key is never stored — only whether to pass it to the agent.">
                <div className="seg">
                  <button className={s.executionMode !== "api" ? "on" : ""} onClick={() => set({ executionMode: "subscription" })}><InfinityIcon size={14} /> Subscription</button>
                  <button className={s.executionMode === "api" ? "on" : ""} onClick={() => set({ executionMode: "api" })}><Key size={14} /> API</button>
                </div>
              </Row>
              <Row label="Sandboxing" hint="Direct runs agents as normal processes — fast, full access to your machine (the default). Sandbox boxes each agent in a hardened container: only its own copy of the repo is visible, network limited to Anthropic, privileges dropped. For untrusted work or a client demo.">
                <SandboxControl value={s.isolation} onChange={(v) => set({ isolation: v })} />
              </Row>
              <Row label="Delivery: a PR per ticket" hint="OFF (default): each verified ticket merges straight into the base branch — one integrated result lands locally. ON: each verified ticket is pushed to its own branch and opened as a GitHub PR instead — your base branch does NOT move until you merge those PRs yourself, and a batch becomes several separate PRs to review. Needs a connected GitHub repo.">
                <input type="checkbox" className="switch" checked={s.prNative} onChange={(e) => set({ prNative: e.target.checked })} />
              </Row>
              <Row label="Code reviewer" hint="A second AI double-checks every change before merge: scope, gamed tests, obvious bugs.">
                <input type="checkbox" className="switch" checked={s.reviewer} onChange={(e) => set({ reviewer: e.target.checked })} />
              </Row>
              <Row label="Internet access" hint="Agents may search and read the web. Needed for research; adds exposure to web content.">
                <input type="checkbox" className="switch" checked={s.internet} onChange={(e) => set({ internet: e.target.checked })} />
              </Row>
            </Section>

            <Section id="set-advanced" title="Advanced">
              <p className="settings-sub">Sensible defaults — you rarely need to touch these.</p>
              <Row label="Planning model" hint="The ticket-maker explores the repo once and saves a reusable map. A cheaper tier here cuts planning cost. Default matches the coding model.">
                <Select value={s.planModel} onChange={(v) => set({ planModel: v })} ariaLabel="Planning model"
                  options={planChoices.map(([value, label]) => ({ value, label }))} />
              </Row>
              <Row label="Thinking effort" hint="How hard each agent thinks. Higher digs deeper but is slower and costs more. Default lets the agent decide.">
                <Select value={s.effort} onChange={(v) => set({ effort: v })} ariaLabel="Thinking effort"
                  options={effortChoices.map(([value, label]) => ({ value, label }))} />
              </Row>
              <Row label="Retries per task" hint="How many times a failing ticket is re-attempted before it needs you. Each retry is a full agent run and steps up a model tier.">
                <input type="number" min="0" className="input num" value={s.maxRetries} onChange={(e) => set({ maxRetries: Math.max(0, Number(e.target.value) || 0) })} />
              </Row>
              <Row label="Integration check" hint="After every ticket merges, run this suite once to prove the merged changes still hold together. Empty = off. Comma-separated.">
                <input className="input" value={s.integrationCommands} placeholder="npm run build, npm test" onChange={(e) => set({ integrationCommands: e.target.value })} />
              </Row>
              <Row label="Notify me" hint="Get pinged when a run finishes or a ticket needs you. Paste a Slack, Discord, or any incoming-webhook URL. Empty = off. Fires server-side, so it works with the browser closed.">
                <input className="input" type="url" value={s.webhookUrl} placeholder="https://hooks.slack.com/services/…" onChange={(e) => set({ webhookUrl: e.target.value })} />
              </Row>
            </Section>

            {testOut !== null && <pre className="doctor-result">{testOut}</pre>}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
