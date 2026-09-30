/** New work › From a goal: the planning agent's lifecycle, lifted from the
 *  classic NewWorkModal with the same requests and edge cases.
 *
 *  - kick: POST /api/plan (draft, or `ask` for the clarify-first pass, with the
 *    operator's answers folded in as `clarifications` on the second pass);
 *  - follow: poll /api/status while the job runs, streaming its output;
 *  - re-attach: a plan already running when the sheet opens (closed and
 *    reopened, or started on another device) is picked up, not restarted;
 *  - autostart: opened with a ready goal (from the supervisor), draft at once. */

import { useEffect, useState } from "react";
import { fetchJSON, postJSON, setRepoPath } from "../../../api.js";
import { toast, useFileAttachments, useManagedInterval } from "../../../core.js";
import type { PlanQuestion } from "../../../tickets.js";
import { useWarden } from "../../data.js";
import type { Attach } from "./Attachments.js";
import { useProjectRepo } from "./RepoRow.js";

export type PlanMode = "tickets" | "questions";

export interface Planner {
  goal: string; setGoal: (v: string) => void;
  att: Attach;
  askMode: boolean; setAskMode: (v: boolean) => void;
  planning: boolean; planMode: PlanMode; planOut: string; planStart: number;
  questions: PlanQuestion[] | null;
  answers: Record<number, string>; setAnswer: (i: number, v: string) => void;
  start: () => Promise<void>;
  skipQuestions: () => Promise<void>;
  draftWithAnswers: () => Promise<void>;
}

/** How often the plan job is polled. */
const PLAN_POLL_MS = 1500;
/** Keep only the tail of the planner's output in memory. */
const PLAN_TAIL_CHARS = 6000;

export function usePlanner(initialGoal: string | undefined, autostart = true): Planner {
  const w = useWarden();
  const repo = useProjectRepo();
  const att = useFileAttachments();
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [askMode, setAskMode] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("tickets");
  const [planOut, setPlanOut] = useState("");
  const [planStart, setPlanStart] = useState(0);
  const [questions, setQuestions] = useState<PlanQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const pollPlan = useManagedInterval();

  const follow = (isAsk: boolean): void => {
    setPlanning(true); setPlanMode(isAsk ? "questions" : "tickets");
    if (!isAsk) setQuestions(null);
    pollPlan((stop) => {
      void (async () => {
        let st: { plan: { state: string; output: string; questions?: PlanQuestion[] } };
        try { st = await fetchJSON("/api/status"); } catch { return; /* next tick retries */ }
        setPlanOut(st.plan.output.slice(-PLAN_TAIL_CHARS));
        if (st.plan.state === "running") return;
        stop(); setPlanning(false);
        if (st.plan.state === "done") {
          if (isAsk) {
            if (st.plan.questions?.length) { setQuestions(st.plan.questions); setAnswers({}); }
            else toast("No questions came back — you can draft directly.", true);
          } else {
            setQuestions(null);
            toast("Tickets drafted — review them below.");
            w.refreshBacklog();
          }
        } else {
          toast(isAsk ? "Couldn't get questions — see the planner's output." : "Planning failed — see the planner's output.", true);
        }
      })();
    }, PLAN_POLL_MS);
  };

  const kick = async (ask: boolean, clarifications?: string): Promise<void> => {
    if (!goal.trim()) { toast("Say what you want done first.", true); return; }
    if (!repo.trim()) { toast("Set this project's repository first.", true); return; }
    setRepoPath(repo.trim());
    try { await postJSON("/api/plan", { goal: goal + att.refs(), repo: repo.trim(), ask, clarifications }); }
    catch (err) { toast(String(err), true); return; }
    att.clear();
    setPlanOut(""); setPlanStart(Date.now());
    follow(ask);
  };

  // Re-attach to a plan that is already running server-side.
  useEffect(() => {
    void (async () => {
      try {
        const st = await fetchJSON<{ plan: { state: string; mode?: PlanMode } }>("/api/status");
        if (st.plan.state === "running") { setPlanStart(Date.now()); follow(st.plan.mode === "questions"); }
      } catch { /* no live plan — nothing to attach to */ }
    })();
  }, []);

  // Opened with a ready goal: draft straight away (the operator already agreed
  // to it in chat) — once the project's repo is known, so the plan can't run
  // against another project's repo. A pre-filled goal the operator should read
  // first ("Plan a split") opens with autostart off.
  const [autostarted, setAutostarted] = useState(!autostart);
  useEffect(() => {
    if (autostarted || !initialGoal?.trim() || !repo.trim()) return;
    setAutostarted(true);
    void kick(false);
  }, [repo, autostarted]);

  const draftWithAnswers = (): Promise<void> => {
    const clar = (questions ?? [])
      .map((q, i) => { const a = (answers[i] ?? "").trim(); return a ? `- ${q.q}\n  -> ${a}` : null; })
      .filter(Boolean).join("\n");
    if (!clar) { toast("Answer at least one question, or skip to draft directly.", true); return Promise.resolve(); }
    return kick(false, clar);
  };

  return {
    goal, setGoal, att, askMode, setAskMode,
    planning, planMode, planOut, planStart, questions,
    answers, setAnswer: (i, v) => setAnswers((a) => ({ ...a, [i]: v })),
    start: () => kick(askMode),
    skipQuestions: () => kick(false),
    draftWithAnswers,
  };
}
