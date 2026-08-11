import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Appearance } from "./screens-theme.js";
import { fetchJSON, postJSON, scopedJSON, setRepoPath, setWs } from "./api.js";
import { generateConfig, parseSettings, ago, fmtUsd } from "./model.js";
import type { Settings } from "./model.js";
import { qrSvg } from "./qr.js";
import { ArrowRight, Check, MoreHorizontal, ShieldCheck, Smartphone, Upload, X } from "./icons.js";
import { Modal, ConfirmButton, sendControl } from "./widgets.js";
import { NewWorkModal } from "./work.js";
import { toast, Skeleton } from "./core.js";
import { PageHead, StatTile, SegBar } from "./screens-layout.js";
import { AppBar, AppearanceModal } from "./screens.js";
import type { HeaderMenu } from "./screens.js";

export interface PortfolioProject {
  name: string; workdir: string; currentRun: string | null; running: boolean;
  counts: { queued: number; working: number; needs: number; merged: number };
  total: number; spend: number; tokens: number; budget: number | null; ended: boolean; updatedTs: string | null;
}

export function projStatus(c: PortfolioProject["counts"]): { fam: string; label: string } {
  if (c.needs > 0) return { fam: "blocked", label: "Needs you" };
  if (c.working > 0) return { fam: "working", label: "Working" };
  if (c.queued > 0) return { fam: "upnext", label: "Up next" };
  if (c.merged > 0) return { fam: "merged", label: "Up to date" };
  return { fam: "upnext", label: "No run yet" };
}

export function ProjectCard({ p, onOpen, onEdit }: { p: PortfolioProject; onOpen: () => void; onEdit: () => void }): JSX.Element {
  const c = p.counts;
  const st = projStatus(c);
  const tot = c.merged + c.working + c.needs + c.queued || 1;
  const segs = [
    { count: c.merged, color: "var(--st-merged-dot)" },
    { count: c.working, color: "var(--st-working-dot)" },
    { count: c.needs, color: "var(--st-failed-dot)" },
    { count: c.queued, color: "var(--st-upnext-dot)" },
  ].filter((x) => x.count > 0).map((x) => ({ pct: (x.count / tot) * 100, color: x.color }));
  const bpct = p.budget ? Math.min(100, (p.spend / p.budget) * 100) : 0;
  const bcls = bpct >= 90 ? "over" : bpct >= 70 ? "warn" : "";
  const metric = (n: number, label: string) => (
    <div className="pm">
      <span className="pm-n" style={{ color: n > 0 ? "var(--ink)" : "var(--faint)" }}>{n}</span>
      <span className="pm-l">{label}</span>
    </div>
  );
  return (
    <div className={`proj-card${c.needs > 0 ? " attention" : ""}`} onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <div className="proj-head">
        <div className="proj-name">{p.name}</div>
        <button className="proj-edit" aria-label="Edit or remove this project" title="Edit or remove this project"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}><MoreHorizontal size={16} /></button>
        <span className={`pill fam-${st.fam}`}>{st.label}</span>
      </div>
      <div className="proj-repo mono">{p.workdir.split(/[\\/]/).pop()}</div>
      {segs.length > 0 ? <SegBar segs={segs} /> : <div className="seg-bar empty" />}
      <div className="proj-metrics">
        {metric(c.working, "working")}
        {metric(c.needs, "attention")}
        {metric(c.queued, "up next")}
        {metric(c.merged, "merged")}
      </div>
      {p.budget !== null && p.budget > 0 && (
        <div className="proj-budget">
          <div className="budget-bar"><div className={`budget-fill ${bcls}`} style={{ width: `${bpct}%` }} /></div>
          <span className="budget-cap">{fmtUsd(p.spend)} / {fmtUsd(p.budget)}</span>
        </div>
      )}
      <div className="proj-foot">
        <span className="proj-updated">{p.updatedTs ? `updated ${ago(p.updatedTs)}` : "no activity"}</span>
        <span className="proj-open">Open <ArrowRight size={13} /></span>
      </div>
    </div>
  );
}

export function usePortfolio(): { projects: PortfolioProject[] | null; reload: () => void } {
  const [projects, setProjects] = useState<PortfolioProject[] | null>(null);
  const mounted = useRef(true);
  const reload = useCallback(async (): Promise<void> => {
    try { const r = await fetchJSON<{ projects: PortfolioProject[] }>("/api/portfolio"); if (mounted.current) setProjects(r.projects); }
    catch { /* keep the previous projects */ }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const id = setInterval(() => void reload(), 4000);
    return () => { mounted.current = false; clearInterval(id); };
  }, [reload]);
  return { projects, reload: () => void reload() };
}

export function Onboarding({ onOpen, onCreated }: { onOpen: (name: string) => void; onCreated: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [fresh, setFresh] = useState(false);
  const [project, setProject] = useState<Settings["project"]>("node");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);

  const setupFor: Record<Settings["project"], string> = {
    node: "npm install", python: "uv sync", other: "",
  };
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(name.trim());
  const ready = nameOk && folder.trim() && !busy;

  const create = async (): Promise<void> => {
    setBusy(true);
    const ws = name.trim(), dir = folder.trim();
    try {
      if (fresh) await postJSON("/api/repo/init", { path: dir });
      await postJSON("/api/workspaces", { name: ws, workdir: dir });
      const cfg = generateConfig({
        slots: 3, internet: false, project, setupCommands: setupFor[project],
        integrationCommands: "", reviewer: false, reviewerModel: "haiku", planModel: "",
        model: "", effort: "", maxRetries: 1, budgetUsd: budget.trim(), manualApproval: false,
        prNative: false, webhookUrl: "", executionMode: "subscription", isolation: "direct",
        knowledge: false,
      });
      await scopedJSON("/api/config", ws, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cfg }),
      });
      setRepoPath(dir); setWs(ws);
      onCreated();
      toast(`Project "${ws}" is ready.`);
      onOpen(ws);
    } catch (err) { toast(String(err), true); setBusy(false); }
  };

  const reassure = project === "python" ? "Runs uv sync, then lands you in the cockpit."
    : project === "node" ? "Runs npm install, then lands you in the cockpit."
      : "Lands you straight in the cockpit.";

  return (
    <div className="onboard">
      <div className="onboard-mark" aria-hidden="true"><ShieldCheck size={30} strokeWidth={2} /></div>
      <div className="onboard-word">Warden</div>
      <h1 className="onboard-title">Let's set up your first project.</h1>
      <p className="onboard-thesis">A project is a work folder Warden drives agents against — in parallel, each behind one deterministic gate. No terminal needed.</p>

      <div className="onboard-card">
        <div className="onboard-group">
          <label className="work-label">Project name</label>
          <input className="input" placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} />
          {name.trim() && !nameOk && <p className="onboard-warn">Use only letters, numbers, dashes or underscores.</p>}
        </div>

        <div className="onboard-group">
          <label className="work-label">Repository / work folder</label>
          <input className="input" placeholder="C:\path\to\your\repo" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <div className="seg onboard-seg">
            <button className={!fresh ? "on" : ""} onClick={() => setFresh(false)}>Use an existing repo</button>
            <button className={fresh ? "on" : ""} onClick={() => setFresh(true)}>Start fresh here</button>
          </div>
          {fresh && <p className="onboard-hint">The folder is created and <code>git init</code>'d with a first commit.</p>}
        </div>

        <div className="onboard-group onboard-row">
          <div className="onboard-col">
            <label className="work-label">Stack</label>
            <div className="seg onboard-seg">
              {(["node", "python", "other"] as const).map((p) => (
                <button key={p} className={project === p ? "on" : ""} onClick={() => setProject(p)}>
                  {p === "node" ? "Node" : p === "python" ? "Python" : "Other"}
                </button>
              ))}
            </div>
          </div>
          <div className="onboard-col">
            <label className="work-label">Budget · USD, optional</label>
            <input className="input num" type="number" min="0" placeholder="no cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
        </div>

        <div className="onboard-foot">
          <button className="btn primary onboard-go" disabled={!ready} onClick={() => void create()}>
            {busy ? "Setting up…" : <>Create project <ArrowRight size={14} /></>}
          </button>
          {!busy && <span className="onboard-reassure">{reassure}</span>}
        </div>
      </div>
    </div>
  );
}

export function ProjectEditor(
  { p, canDelete, onClose, onChanged }:
  { p: PortfolioProject; canDelete: boolean; onClose: () => void; onChanged: () => void },
): JSX.Element {
  const [name, setName] = useState(p.name);
  const [budget, setBudget] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void scopedJSON<{ content: string }>("/api/config", p.name)
      .then(({ content }) => {
        const s = parseSettings(content);
        setBudget(s.budgetUsd ? String(s.budgetUsd) : "");
      })
      .catch(() => { /* no config yet — budget stays blank (no cap) */ })
      .finally(() => setLoaded(true));
  }, [p.name]);

  const save = async (): Promise<void> => {
    const newName = name.trim();
    if (!newName) { toast("A project needs a name.", true); return; }
    try {
      const trimmed = budget.trim();
      const cap = trimmed === "" ? null : Number(trimmed);
      if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error("budget must be a positive number");
      const { content } = await scopedJSON<{ content: string }>("/api/config", p.name);
      const s = parseSettings(content);
      await scopedJSON("/api/config", p.name, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: generateConfig({ ...s, budgetUsd: cap === null ? "" : String(cap) }) }),
      });
      if (newName !== p.name) {
        await fetchJSON(`/api/workspaces/${encodeURIComponent(p.name)}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
      }
      toast("Project updated."); onChanged();
    } catch (err) { toast(String(err), true); }
  };

  const remove = async (): Promise<void> => {
    try {
      await fetchJSON(`/api/workspaces/${encodeURIComponent(p.name)}`, { method: "DELETE" });
      toast(`Removed ${p.name} from the dashboard. Its files stay on disk.`); onChanged();
    } catch (err) { toast(String(err), true); }
  };

  return (
    <Modal title={`Edit ${p.name}`} onClose={onClose}>
      <div className="work-form">
        <label className="work-label">Project name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="proj-edit-repo">Repository: <span className="mono">{p.workdir}</span></div>
        <label className="work-label">Budget cap (USD) — this project only</label>
        <input className="input num" type="number" min="0" step="1" value={budget}
          placeholder={loaded ? "no cap" : "loading…"} disabled={!loaded}
          onChange={(e) => setBudget(e.target.value)} />
        <p className="work-hint">The run stops launching new agents once this project's spend reaches the cap. Blank means no cap.</p>
      </div>
      <div className="panel-foot spread modal-foot">
        {canDelete
          ? <ConfirmButton label="Remove project" confirm="Sure? Click again" onConfirm={() => void remove()} />
          : <span className="work-hint">The last project can't be removed.</span>}
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

export interface NetInfo { ip: string | null; port: number; url: string | null }

export function PhoneCard({ theme }: { theme: Appearance }): JSX.Element | null {
  const [net, setNet] = useState<NetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("factory.phonecard") === "off"; } catch { return false; }
  });
  useEffect(() => {
    let alive = true;
    fetchJSON<NetInfo>("/api/netinfo").then((n) => { if (alive) setNet(n); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (dismissed || !net?.url) return null;
  const dark = theme.dark ? "#e8eaed" : "#111";
  const svg = qrSvg(net.url, { ec: "M", scale: 5, border: 2, dark, light: "transparent" });
  const dismiss = (): void => {
    setDismissed(true);
    try { localStorage.setItem("factory.phonecard", "off"); } catch { /* ignore */ }
  };
  const copy = (): void => {
    void navigator.clipboard?.writeText(net.url!).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="phone-card">
      <div className="phone-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="phone-body">
        <div className="phone-title"><Smartphone size={16} /> Open on your phone</div>
        <div className="phone-sub">Scan with your camera on the same Wi-Fi to drive the factory from your phone.</div>
        <button className="phone-url" onClick={copy} title="Copy URL">
          <code>{net.url}</code>
          <span className="phone-copy">{copied ? <><Check size={12} /> copied</> : "copy"}</span>
        </button>
      </div>
      <button className="phone-x" onClick={dismiss} title="Dismiss" aria-label="Dismiss">×</button>
    </div>
  );
}

export function ProjectsScreen(
  { theme, onOpen, onMemory, menu }:
  { theme: Appearance; onOpen: (name: string) => void; onMemory: () => void; menu: HeaderMenu },
): JSX.Element {
  const { projects, reload } = usePortfolio();
  const [showNew, setShowNew] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [editing, setEditing] = useState<PortfolioProject | null>(null);
  const list = projects ?? [];
  const working = list.reduce((s, p) => s + p.counts.working, 0);
  const need = list.filter((p) => p.counts.needs > 0).length;
  const spend = list.reduce((s, p) => s + p.spend, 0);
  const synth = need > 0 ? `${need} project${need > 1 ? "s need" : " needs"} you` : "Everything is under control";

  return (
    <>
      <AppBar active="projects" newLabel="New project" theme={theme} onProjects={() => {}} onMemory={onMemory} onNew={() => setShowNew(true)} onAppearance={() => setShowAppearance(true)} menu={menu} />
      <div className="page">
        {list.length > 0 && (
          <PageHead title="Your projects" synthFam={need > 0 ? "blocked" : "merged"} synth={synth}
            stats={<>
              <StatTile value={list.length} label="Projects" />
              <StatTile value={working} label="Agents working" color="var(--st-working-fg)" />
              <StatTile value={need} label="Need you" color={need > 0 ? "var(--st-failed-fg)" : undefined} />
              <StatTile value={fmtUsd(spend)} label="Spent" />
            </>} />
        )}

        {list.length > 0 && <PhoneCard theme={theme} />}

        {projects === null ? (
          <div className="empty-state" style={{ alignSelf: "stretch" }}><Skeleton lines={4} /></div>
        ) : list.length === 0 ? (
          <Onboarding onOpen={onOpen} onCreated={reload} />
        ) : (
          <div className="proj-grid">
            {list.map((p) => <ProjectCard key={p.name} p={p} onOpen={() => onOpen(p.name)} onEdit={() => setEditing(p)} />)}
            <button className="proj-new" onClick={() => setShowNew(true)}><span className="plus-lg">+</span> New project</button>
          </div>
        )}
      </div>
      {showNew && <NewWorkModal variant="project" initialTab="goal" onClose={() => setShowNew(false)} onWorkspaceAdded={() => { /* the portfolio poll picks it up */ }} />}
      {editing && (
        <ProjectEditor p={editing} canDelete={list.length > 1}
          onClose={() => setEditing(null)}
          onChanged={() => { setEditing(null); reload(); }} />
      )}
      {showAppearance && <AppearanceModal theme={theme} onClose={() => setShowAppearance(false)} />}
    </>
  );
}
