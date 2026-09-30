/** Everything about one ticket, in a side sheet over the board (replaces the
 *  classic LogModal). Header: id, state, attempt, pinned model/effort, and the
 *  measures (time, cost, tokens). Tabs: Story (narrated log + lessons), Diff
 *  (opens the diff page), Why it failed (failed tickets only), Raw log. The log
 *  is tailed while the ticket was in flight when the sheet opened, loaded once
 *  otherwise. The footer holds the actions valid for the ticket's state. */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { getText } from "../../../api.js";
import { usePolling } from "../../../core.js";
import { fmtDuration, fmtTokens, fmtUsd, inFlight, narrate } from "../../../model.js";
import { sendControl } from "../../../control.js";
import { useWarden } from "../../data.js";
import { Brain } from "../../icons.js";
import { Btn, Empty, STATE_LABEL, Seg, Sheet, StateTag, Tag } from "../../ui.js";
import { useTicketActions } from "../board/actions.js";
import { StoryTimeline, TicketLessons } from "./StoryTab.js";
import { requestedTab } from "./tabs.js";
import type { TicketTab } from "./tabs.js";
import { TicketFooter } from "./TicketFooter.js";
import { WhyTab } from "./WhyTab.js";

/** Tail cadence for a ticket's log while it is still running. */
const LOG_POLL_MS = 1500;

export function TicketSheet({ taskId }: { taskId: string }): JSX.Element {
  const w = useWarden();
  const act = useTicketActions();
  const t = w.model.tasks.get(taskId);
  const [tab, setTab] = useState<TicketTab>(() => requestedTab(taskId) ?? "story");
  const [raw, setRaw] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [following, setFollowing] = useState(inFlight(t?.state));
  const bodyRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(t?.state);
  stateRef.current = t?.state;

  // Tail the log only if the ticket was in flight when opened; otherwise load it once.
  const followAtOpen = useMemo(() => inFlight(t?.state), [taskId]);
  usePolling(async ({ alive }) => {
    const text = await getText(`/api/log?task=${encodeURIComponent(taskId)}`);
    if (!alive()) return;
    if (text !== null) { setRaw(text); setMissing(false); } else setMissing(true);
    if (!inFlight(stateRef.current)) setFollowing(false);
  }, followAtOpen ? LOG_POLL_MS : null, [taskId]);

  // Keep the newest step in view while following, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = bodyRef.current?.closest(".sheet-body");
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [raw, tab]);

  const story = useMemo(() => (raw ? narrate(raw) : []), [raw]);

  if (!t) {
    return (
      <Sheet title={`Ticket ${taskId}`} onClose={w.close}>
        <Empty title="This ticket isn't in the current run">It may belong to an older run, or its history was cleared.</Empty>
      </Sheet>
    );
  }

  const failed = t.state === "FAILED";
  const current: TicketTab = tab === "why" && !failed ? "story" : tab;
  const running = t.state === "RUNNING" && t.runningSince !== null;
  const time = running ? fmtDuration((w.now - t.runningSince!) / 1000) : t.wallS !== null ? fmtDuration(t.wallS) : null;
  const tokens = running ? t.liveTokens : t.tokens;
  const options: Array<{ value: TicketTab | "diff"; label: string }> = [
    { value: "story", label: "Story" },
    ...(t.diff ? [{ value: "diff" as const, label: "Diff" }] : []),
    ...(failed ? [{ value: "why" as const, label: "Why it failed" }] : []),
    { value: "raw", label: "Raw log" },
  ];
  const attention = t.state === "FAILED" || t.state === "BLOCKED";
  const undo = t.state === "AWAITING_APPROVAL" && w.live && t.checkpoints.length > 0
    ? { checkpoints: t.checkpoints, onUndo: (sha: string) => void sendControl("undo", t.id, undefined, sha) }
    : undefined;

  const eyebrow = (
    <>
      <span className="mono faint">{t.id}</span>
      <StateTag state={t.state} />
      {following && <Tag color="var(--st-working)" dot>live</Tag>}
      {t.retries > 0 && <Tag>attempt {t.retries + 1}</Tag>}
      {t.model && <Tag>{t.model}</Tag>}
      {t.effort && <Tag><Brain size={11} /> {t.effort}</Tag>}
    </>
  );
  const head = (
    <div className="stack tk-head">
      <div className="row tk-meas">
        {/* No recorded duration means "never ran" only while the ticket is still
            queued; a finished ticket from an older log simply has no timing. */}
        {time ? <span>{time}</span> : t.state === "QUEUED" && <span>not started</span>}
        {t.costUsd > 0 && <span>{fmtUsd(t.costUsd)}</span>}
        {tokens > 0 && <span>{fmtTokens(tokens)} tokens{running ? " so far" : ""}</span>}
        {running && t.liveTurns > 0 && <span>turn {t.liveTurns}</span>}
        <span>attempt {t.retries + 1}</span>
      </div>
      <Seg label="Ticket view" value={current as TicketTab | "diff"} options={options}
        onChange={(v) => { if (v === "diff") act.diff(t); else setTab(v); }} />
    </div>
  );

  return (
    <Sheet wide title={t.title} eyebrow={eyebrow} headExtra={head} onClose={w.close}
      footer={<TicketFooter t={t} act={act} />}>
      <div ref={bodyRef} className="stack tk-body">
        {current === "why" ? <WhyTab taskId={t.id} run={w.model.run || null} />
          : raw === null ? (missing
            ? (t.diff
              // A ticket merged by an earlier run keeps its change even when its
              // log wasn't carried over: lead to what IS there.
              ? <div className="card tight tk-nolog">
                  <b>{t.state === "DONE" ? "Merged" : STATE_LABEL[t.state]} — its step-by-step log wasn’t kept.</b>
                  <p className="hint">The change itself is recorded: read exactly what it did to your code.</p>
                  <div><Btn small kind="fill" onClick={() => act.diff(t)}>View the change</Btn></div>
                </div>
              : <p className="hint">No log recorded for this ticket yet.</p>)
            : <div className="stack">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton tk-skel" />)}</div>)
          : current === "raw" ? <pre className="code tk-pre tk-raw">{raw}</pre>
          : <StoryTimeline story={story} tokens={t.liveTokens || t.tokens} undo={undo} />}
        {current === "story" && (
          <>
            <div className="divider" />
            <TicketLessons taskId={t.id} draft={attention && t.note ? `${t.note}\n\nLesson: ` : ""} />
          </>
        )}
      </div>
    </Sheet>
  );
}
