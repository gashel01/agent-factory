/** Projects: every registered workspace as a card with its live board shape,
 *  spend and budget (/api/portfolio, polled), totals on top, the phone link,
 *  and the two ways in — "New project" for a repo, or the first-run onboarding
 *  when nothing is registered yet. Opening a card makes it the current project
 *  and lands on its board. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fmtUsd } from "../../../model.js";
import { useWarden } from "../../data.js";
import { Plus, Search, Smartphone } from "../../icons.js";
import { Btn, Empty, IconBtn, Stat, Tag } from "../../ui.js";
import { Topbar } from "../../shell/Topbar.js";
import { NewProjectSheet } from "./NewProjectSheet.js";
import { Onboarding } from "./Onboarding.js";
import { PhoneCard, readPhoneDismissed, writePhoneDismissed } from "./PhoneCard.js";
import { ProjectCard } from "./ProjectCard.js";
import { usePortfolio } from "./portfolio.js";

export function ProjectsPage(): JSX.Element {
  const w = useWarden();
  const { projects, reload } = usePortfolio();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [phoneOff, setPhoneOff] = useState(readPhoneDismissed);

  // An edit or removal happens in the project sheet: refresh as soon as it closes
  // rather than waiting for the next poll.
  useEffect(() => { if (w.overlay === null) reload(); }, [w.overlay]);

  const list = projects ?? [];
  const working = list.reduce((s, p) => s + p.counts.working, 0);
  const need = list.filter((p) => p.counts.needs > 0).length;
  const spend = list.reduce((s, p) => s + p.spend, 0);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? list.filter((p) => p.name.toLowerCase().includes(needle) || p.workdir.toLowerCase().includes(needle))
    : list;
  const repoOf = (name: string): string | null => w.workspaces.find((x) => x.name === name)?.repo ?? null;
  const openProject = (name: string): void => { w.switchWs(name); w.go("board"); };
  const setPhone = (off: boolean): void => { writePhoneDismissed(off); setPhoneOff(off); };

  const sub = list.length === 0 ? undefined
    : need > 0 ? `${need} project${need > 1 ? "s need" : " needs"} you` : "Everything is under control";

  return (
    <>
      <Topbar title="Projects" sub={sub}>
        {need > 0 && <Tag color="var(--st-needs)" dot>{need} need{need > 1 ? "" : "s"} you</Tag>}
        {list.length > 1 && (
          <label className="search-field pj-search">
            <Search size={15} />
            <input placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
          </label>
        )}
        {list.length > 0 && phoneOff && (
          <IconBtn label="Show the phone link" boxed onClick={() => setPhone(false)}><Smartphone size={17} /></IconBtn>
        )}
        {list.length > 0 && <Btn kind="fill" onClick={() => setCreating(true)}><Plus size={15} /> New project</Btn>}
      </Topbar>
      <div className="view">
        {projects === null ? (
          <div className="pj-grid" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton pj-skeleton" />)}
          </div>
        ) : list.length === 0 ? (
          <Onboarding onCreated={reload} />
        ) : (
          <>
            <div className="pj-stats">
              <Stat value={list.length} label="Projects" />
              <Stat value={working} label="Agents working" color={working > 0 ? "var(--st-working)" : undefined} />
              <Stat value={need} label="Need you" color={need > 0 ? "var(--st-needs)" : undefined} />
              <Stat value={fmtUsd(spend)} label="Spent" />
            </div>
            <div className="pj-grid">
              {shown.map((p) => (
                <ProjectCard key={p.name} p={p} repo={repoOf(p.name)} current={p.name === w.ws}
                  onOpen={() => openProject(p.name)}
                  onEdit={() => w.open({ type: "projectedit", name: p.name })} />
              ))}
              {!needle && (
                <button type="button" className="pj-new" onClick={() => setCreating(true)}>
                  <span className="pj-new-plus" aria-hidden="true"><Plus size={20} /></span>
                  <b className="pj-new-title">New project</b>
                  <span className="pj-new-sub">Point Warden at a repository</span>
                </button>
              )}
              {!phoneOff && <PhoneCard onDismiss={() => setPhone(true)} />}
            </div>
            {needle && shown.length === 0 && <Empty title="No project matches">Nothing named or located like “{q.trim()}”.</Empty>}
          </>
        )}
      </div>
      {creating && <NewProjectSheet onClose={() => setCreating(false)} onCreated={reload} />}
    </>
  );
}
