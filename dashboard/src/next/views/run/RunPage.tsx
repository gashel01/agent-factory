/** Run & preview — the project cockpit. On the left, what the project's
 *  capsule (capsule.json) declares: toolchain checks, approvals, actions grouped
 *  as the capsule groups them, panels, and a plain-words editor for the capsule
 *  itself. On the right, the stage: the selected thing's live output, or the
 *  running app.
 *
 *  The classic "Project cockpit" modal rendered nothing at all when its first
 *  request failed, and a bare sentence without a capsule. Here every state says
 *  what it is and what to do: loading, unreachable, no repository yet (set it on
 *  the Repository page), no capsule yet (generate one — the onboarding agent
 *  reads the repo, read-only), and the preview works with or without one. */

import { useState } from "react";
import type { JSX } from "react";
import type { CapsuleAction } from "../../../types.js";
import { useWarden } from "../../data.js";
import { Check, ChevronRight, Sparkles, Wand2 } from "../../icons.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Empty, Spinner, Tag } from "../../ui.js";
import { useProjectRepo } from "../repo/project-repo.js";
import { ActionCard } from "./ActionCard.js";
import { CapsuleChat } from "./CapsuleChat.js";
import { ConsentCard } from "./Consent.js";
import { Panels } from "./Panels.js";
import { Stage } from "./Stage.js";
import type { StageTab, StageTarget } from "./Stage.js";
import { useCapsule } from "./useCapsule.js";
import type { Cockpit } from "./useCapsule.js";
import { usePreview } from "./usePreview.js";

/** Cluster actions by their optional `group`, preserving first-seen order
 *  (classic groupActions); ungrouped ones form one unnamed section. */
function groupActions(acts: CapsuleAction[]): Array<[string, CapsuleAction[]]> {
  const order: string[] = [];
  const by = new Map<string, CapsuleAction[]>();
  for (const a of acts) {
    const g = a.group ?? "";
    if (!by.has(g)) { by.set(g, []); order.push(g); }
    by.get(g)!.push(a);
  }
  return order.map((g) => [g, by.get(g)!]);
}

function FirstRun({ c, hasRepo, onWatch }: { c: Cockpit; hasRepo: boolean; onWatch: () => void }): JSX.Element {
  const w = useWarden();
  const generating = c.gen?.state === "running";
  if (!hasRepo) {
    return (
      <Empty icon={<Wand2 size={22} />} title="No repository for this project yet"
        action={<Btn kind="fill" onClick={() => w.go("repo")}>Set the repository</Btn>}>
        The cockpit is built from the project's code. Point the project at its repository first — it takes one field on the Repository page.
      </Empty>
    );
  }
  return (
    <div className="card rn-first">
      <span className="empty-state-icon" aria-hidden="true"><Wand2 size={22} /></span>
      <b className="rn-first-title">No cockpit for this project yet</b>
      <p className="hint">
        Warden can read the repository (read-only) and write its cockpit: how to install, build, test and run it, the checks
        its toolchain needs, and the buttons to show here. You review it before anything installs on this machine.
      </p>
      <div className="row rn-wrap">
        <Btn kind="fill" busy={generating} onClick={() => { onWatch(); return c.generate(); }}>
          <Sparkles size={14} /> {generating ? "Inspecting the repo…" : "Generate the cockpit"}
        </Btn>
        {(generating || c.gen?.state === "error") && <Btn kind="ghost" onClick={onWatch}>See its progress <ChevronRight size={14} /></Btn>}
      </div>
      {c.gen?.state === "error" && <p className="rp-note">Generation failed — its output is on the right.</p>}
      <p className="faint rn-small">Meanwhile, Preview on the right can already serve a web project as it is.</p>
    </div>
  );
}

function Doctor({ c, onWatch }: { c: Cockpit; onWatch: () => void }): JSX.Element | null {
  const checks = c.view?.capsule?.doctor ?? [];
  if (checks.length === 0) return null;
  const missing = checks.some((d) => c.view?.doctor[d.id] === false);
  return (
    <section className="stack rn-gap-8" aria-label="Toolchain">
      <span className="label">Toolchain</span>
      <div className="row rn-wrap">
        {checks.map((d) => {
          const ok = c.view?.doctor[d.id];
          return (
            <span key={d.id} title={`${ok ? "present" : "missing"} · probe: ${d.probe}`}>
              <Tag color={ok ? "var(--st-merged)" : "var(--st-review)"}>{ok ? <Check size={12} /> : "!"} {d.label}</Tag>
            </span>
          );
        })}
        {missing && (
          <Btn small kind="fill" busy={c.prov?.state === "running"} onClick={() => { onWatch(); return c.provision(); }}>
            <Sparkles size={13} /> {c.prov?.state === "running" ? "Diagnosing…" : "Fix with AI"}
          </Btn>
        )}
      </div>
    </section>
  );
}

export function RunPage(): JSX.Element {
  const w = useWarden();
  const pr = useProjectRepo();
  const c = useCapsule(w.ws);
  const preview = usePreview(pr.repo, w.ws);
  const [target, setTarget] = useState<StageTarget>(null);
  const [tab, setTab] = useState<StageTab>("output");
  const watch = (t: string): void => { setTarget(t); setTab("output"); };

  const view = c.view;
  const capsule = view?.capsule ?? null;
  const grants = new Set(view?.grants ?? []);
  const pending = (capsule?.consents ?? []).filter((x) => !grants.has(x.id));
  const granted = (capsule?.consents ?? []).filter((x) => grants.has(x.id));

  let side: JSX.Element;
  if (c.loadError) {
    side = <Empty title="Couldn't load the cockpit" action={<Btn onClick={c.refresh}>Try again</Btn>}>{c.loadError}</Empty>;
  } else if (!view || pr.loading) {
    side = <div className="rp-center"><Spinner /></div>;
  } else if (!capsule) {
    side = <FirstRun c={c} hasRepo={Boolean(pr.repo)} onWatch={() => watch("__generate__")} />;
  } else {
    side = (
      <>
        {capsule.summary && <p className="hint">{capsule.summary}</p>}
        <Doctor c={c} onWatch={() => watch("__provision__")} />
        {pending.map((x) => <ConsentCard key={x.id} consent={x} onApprove={() => c.grant(x)} />)}
        {capsule.actions.length === 0 && <p className="hint">The capsule declares no actions — ask for some below.</p>}
        {groupActions(capsule.actions).map(([group, items]) => (
          <section key={group || "_flat"} className="stack rn-gap-8" aria-label={group || "Actions"}>
            <span className="label">{group || "Actions"}</span>
            {items.map((a) => (
              <ActionCard key={a.id} a={a} c={c} view={view} selected={target === a.id} onSelect={() => watch(a.id)} />
            ))}
          </section>
        ))}
        <Panels panels={capsule.panels ?? []} />
        {granted.length > 0 && (
          <div className="row rn-wrap" aria-label="Approved">
            {granted.map((x) => <Tag key={x.id} color="var(--st-merged)"><Check size={12} /> {x.title}</Tag>)}
          </div>
        )}
        <CapsuleChat c={c} />
      </>
    );
  }

  const pv = preview;
  return (
    <>
      <Topbar title="Run & preview" sub={capsule?.name ?? "Build, verify and launch what the agents made"}>
        {pv.state === "ready" && pv.url && <Tag color="var(--st-merged)" dot>Preview live</Tag>}
        {pv.state === "starting" && <Tag color="var(--st-working)" dot>Preview starting</Tag>}
        {pv.state === "ready"
          ? <Btn onClick={() => setTab("preview")}>Show preview</Btn>
          : (pv.kind === "web" || pv.kind === "static") && pv.state !== "starting" &&
            <Btn kind="fill" onClick={() => { setTab("preview"); return pv.start(); }}>Start preview</Btn>}
      </Topbar>
      <div className="view rn-view">
        <div className="rn-layout">
          <div className="stack rn-side">{side}</div>
          <Stage c={c} view={view} preview={preview} target={target} tab={tab} setTab={setTab} />
        </div>
      </div>
    </>
  );
}
