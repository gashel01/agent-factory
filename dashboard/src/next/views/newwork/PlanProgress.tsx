/** Live feedback while the planning agent explores the repo: elapsed time, a
 *  running tally (files read, searches) and a scrolling feed of its moves, so a
 *  wait of a few minutes stays legible. Lines come from `factory plan` stdout,
 *  each prefixed "· " by the CLI (same parsing as the classic PlanProgress). */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { stepIcon } from "../../../tickets.js";
import type { PlanMode } from "./usePlanner.js";

/** How many of the latest moves stay in the feed. */
const FEED_TAIL = 40;

export function PlanProgress({ output, startMs, mode }: { output: string; startMs: number; mode: PlanMode }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const steps = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("· ")).map((l) => l.slice(2));
  const reads = steps.filter((s) => s.startsWith("reading ")).length;
  const searches = steps.filter((s) => s.startsWith("searching") || s.startsWith("finding files")).length;
  const recent = steps.slice(-FEED_TAIL);
  const feed = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; }, [steps.length]);
  const secs = startMs ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const phase = steps.length === 0
    ? "Waking the planning agent"
    : mode === "questions" ? "Working out what to ask you" : "Exploring your repo to draft tickets";

  return (
    <section className="card tight nw-plan" aria-live="polite">
      <div className="row">
        <span className="spinner" aria-hidden="true" />
        <b className="nw-plan-phase">{phase}…</b>
        <span className="spacer" />
        <span className="mono faint" title="Elapsed">{mmss}</span>
      </div>
      {steps.length > 0 ? (
        <>
          <ol className="nw-plan-steps" ref={feed}>
            {recent.map((s, i) => {
              const Icon = stepIcon(s);
              return (
                <li key={`${i}-${s}`} className={i === recent.length - 1 ? "nw-plan-step now" : "nw-plan-step"}>
                  <Icon size={13} aria-hidden="true" /><span>{s}</span>
                </li>
              );
            })}
          </ol>
          <p className="hint">
            <b>{reads}</b> file{reads === 1 ? "" : "s"} read · <b>{searches}</b> search{searches === 1 ? "" : "es"} ·{" "}
            {mode === "questions" ? "then it’ll ask you a few questions" : "usually 1–3 min; longer on a big repo"}
          </p>
        </>
      ) : (
        <p className="hint">
          {mode === "questions"
            ? "Reading your code so its questions land where they matter — a moment…"
            : "Reading your code to draft parallel-safe tickets — usually 1–3 minutes."}
        </p>
      )}
    </section>
  );
}
