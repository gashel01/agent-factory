/** The Board page — the cockpit of the new interface. Top bar: a live status
 *  tag, the Kanban/Focus switch (remembered) and New work. Below: the notices,
 *  the run card with its controls, a filter once the board is busy, then the
 *  Kanban, the Focus list or the Removed segment. Every ticket action goes
 *  through useTicketActions so the board, focus and the ticket sheet agree. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BoardTicket } from "../../../board-model.js";
import { inFlight } from "../../../model.js";
import { useWarden } from "../../data.js";
import { GitBranch, GitMerge, GitPullRequest, InfinityIcon, Key, Plus, Sparkles } from "../../icons.js";
import { Topbar } from "../../shell/Topbar.js";
import { Btn, Empty, Seg, Tag } from "../../ui.js";
import { useTicketActions } from "./actions.js";
import { AiReviewSheet } from "./AiReviewSheet.js";
import { FocusView } from "./FocusView.js";
import { Kanban } from "./Kanban.js";
import type { BoardProps } from "./Kanban.js";
import { AutopilotNotice, HotspotNotice, IntegrationNotice, SyncNotice } from "./Notices.js";
import { RemovedList } from "./RemovedList.js";
import { RunCard, TONE_COLOR } from "./RunCard.js";

type View = "kanban" | "focus";
const VIEW_KEY = "warden.next.board.view";

function useBoardView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === "focus" ? "focus" : "kanban"; } catch { return "kanban"; }
  });
  const set = (v: View): void => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };
  return [view, set];
}

/** The top bar's one-word run status. */
function StatusTag(): JSX.Element {
  const w = useWarden();
  const { model } = w;
  if (!model.run) return <Tag color="var(--st-queued)" dot>No run yet</Tag>;
  if (w.live) {
    if (model.manualPause || model.ratePause) return <Tag color="var(--st-review)" dot>Paused</Tag>;
    const working = w.visible.filter((t) => inFlight(t.state)).length;
    return <Tag color="var(--st-working)" dot>Run live{working ? ` · ${working} working` : ""}</Tag>;
  }
  if (!model.endedTs) return <Tag color="var(--st-review)" dot>Run stopped</Tag>;
  return <Tag color={TONE_COLOR[w.headline.tone] ?? "var(--st-merged)"} dot>Run finished</Tag>;
}

/** How this project runs — plan or API key, merged or one PR per ticket — in
 *  plain sight on the board, opening the same popover as the rail's plan card. */
function ModeChip(): JSX.Element {
  const w = useWarden();
  const api = w.model.mode === "api";
  const pr = w.model.prMode === true;
  return (
    <button type="button" className="bd-mode" onClick={() => w.open({ type: "mode", from: "top" })}
      title="How this project runs — execution mode and delivery">
      {api ? <Key size={13} /> : <InfinityIcon size={14} />}{api ? "API key" : "Subscription"}
      <span className="bd-mode-sep" aria-hidden="true" />
      {pr ? <GitPullRequest size={13} /> : <GitMerge size={13} />}{pr ? "PR per ticket" : "Integrated"}
    </button>
  );
}

export function BoardPage(): JSX.Element {
  const w = useWarden();
  const act = useTicketActions();
  const [view, setView] = useBoardView();
  const [segment, setSegment] = useState<"active" | "removed">("active");
  const [query, setQuery] = useState("");
  const [reviewing, setReviewing] = useState<BoardTicket | null>(null);

  // "f" flips Kanban/Focus, as in the classic cockpit — never over an overlay or in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (w.overlay || e.metaKey || e.ctrlKey || e.altKey || e.key !== "f") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      setView(view === "focus" ? "kanban" : "focus");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [w.overlay, view]);

  // The filter narrows what the board shows, never the run card (it reflects the whole run).
  const q = query.trim().toLowerCase();
  const shown = q ? w.visible.filter((t) => `${t.id} ${t.title} ${t.note ?? ""}`.toLowerCase().includes(q)) : w.visible;
  const empty = w.tasks.length === 0 && w.pending.length === 0 && w.manual.length === 0;
  const showRemoved = segment === "removed" && w.removed.length > 0;
  // The dependency graph is worth a button only when some ticket waits on another
  // (a draft before the run, or a task of the live run).
  const hasDeps = w.pending.some((t) => t.deps.length > 0) || w.tasks.some((t) => t.deps.length > 0);

  const props: BoardProps = {
    tasks: shown, pending: w.pending, manual: w.manual, live: w.live, now: w.now, autopilot: w.autopilot, act,
    onAdd: () => w.open({ type: "newwork", tab: "one" }),
    onRemove: (id) => void w.removeTicket(id),
    onReview: setReviewing,
  };

  return (
    <>
      <Topbar title="Board" sub={<StatusTag />}>
        {!empty && (
          <Seg label="Board layout" value={view} onChange={setView}
            options={[{ value: "kanban", label: "Kanban" }, { value: "focus", label: "Focus" }]} />
        )}
        <ModeChip />
        <Btn kind="fill" onClick={() => w.open({ type: "newwork" })}><Plus size={15} /> New work</Btn>
      </Topbar>
      <div className="view bd-view">
        <SyncNotice />
        <IntegrationNotice />
        <AutopilotNotice />
        <RunCard />
        <HotspotNotice />

        {(w.tasks.length > 6 || w.removed.length > 0 || hasDeps) && (
          <div className="row bd-toolbar">
            {w.tasks.length > 6 && !showRemoved && (
              <label className="search-field bd-filter">
                <span className="sr-only">Filter tickets</span>
                <input value={query} placeholder="Filter tickets by id, title or note…" onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
            {q && !showRemoved && (
              <span className="faint bd-filter-n">{shown.length} of {w.visible.length}
                <Btn kind="ghost" small onClick={() => setQuery("")}>Clear</Btn></span>
            )}
            <span className="spacer" />
            {hasDeps && !showRemoved && (
              <Btn kind="ghost" small title="Which ticket waits on which, in execution order"
                onClick={() => w.go("insights", "deps")}><GitBranch size={14} /> Dependencies</Btn>
            )}
            {w.removed.length > 0 && (
              <Seg label="Which tickets" value={showRemoved ? "removed" : "active"} onChange={setSegment}
                options={[{ value: "active", label: "Active" }, { value: "removed", label: `Removed · ${w.removed.length}` }]} />
            )}
          </div>
        )}

        {showRemoved ? <RemovedList act={act} />
          : empty ? (
            <Empty icon={<Sparkles size={22} />} title="Let's get some work going."
              action={(
                <div className="row bd-empty-actions">
                  <Btn kind="fill" onClick={() => w.open({ type: "newwork", tab: "one" })}><Plus size={15} /> Add a ticket</Btn>
                  <Btn kind="ghost" onClick={() => w.open({ type: "newwork", tab: "goal" })}><Sparkles size={15} /> Draft several with AI</Btn>
                </div>
              )}>
              Add a ticket to do yourself or hand to the AI — or describe a goal and let it draft the plan for you.
            </Empty>
          )
          : view === "focus" ? <FocusView {...props} /> : <Kanban {...props} />}
      </div>
      {reviewing && <AiReviewSheet ticket={reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}
