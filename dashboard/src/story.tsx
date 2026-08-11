/* Extracted from modals.tsx — mechanical split. */
/** Agent Factory dashboard — story/timeline narration for a task's run log. */

import type { JSX } from "react";
import type { FactoryEvent } from "./types.js";
import { Checkpoint, StoryItem, fmtTokens, fmtUsd } from "./model.js";
import {
  Check, ChevronRight, CornerDownRight, FileText, GitBranch,
  Globe, Lightbulb, ListChecks, Pencil, Search, Terminal, Undo2,
} from "./icons.js";
import type { LucideIcon } from "./icons.js";

export function describe(event: FactoryEvent): string {
  const tag = event.task ? `[${event.task}] ` : "";
  const e = event as unknown as Record<string, unknown>;
  switch (event.event) {
    case "state": return `${tag}${e["from"]} → ${e["to"]}`;
    case "agent_result": return `${tag}agent ${e["status"]} (${e["turns"] ?? "?"} turns${e["cost_usd"] ? `, ${fmtUsd(e["cost_usd"] as number)}` : ""})`;
    case "verify": return `${tag}verify ${e["ok"] ? "ok" : "FAILED: " + (e["failures"] as string[]).join("; ")}`;
    case "retry": return `${tag}retry #${e["attempt"]}: ${e["reason"]}`;
    case "escalate": return `${tag}escalated model ${e["from"]} → ${e["to"]}`;
    case "failure": return `${tag}failed: ${e["reason"]}`;
    case "blocked": return `${tag}blocked: ${e["question"]}`;
    case "answered": return `${tag}answered by the operator — back in the queue`;
    case "lessons": return `${tag}${e["count"]} lesson${e["count"] === 1 ? "" : "s"} recalled into the prompt`;
    case "review": return `${tag}review ${e["verdict"]}`;
    case "budget_exceeded": return `budget reached (${fmtUsd(e["spent_usd"] as number)} / ${fmtUsd(e["budget_usd"] as number)})`;
    case "paused_ratelimit": return `rate limit — pause #${e["pause_n"]}`;
    case "merged": return `${tag}merged into base`;
    case "run_start": return `run started (${e["slots"]} slots)`;
    case "run_end": return `run ${e["stopped"] ? "stopped" : "finished"}`;
    default: return `${tag}${event.event}`;
  }
}

/** Icon + human verb for a tool call, so an `act` step reads as a plain-language
 *  line ("Ran command") above the raw detail — not a bare tool name. Unknown
 *  tools fall back to the tool's own name with a neutral glyph. */
export const ACT_META: Record<string, { Icon: LucideIcon; verb: string }> = {
  Read: { Icon: FileText, verb: "Read a file" },
  Write: { Icon: Pencil, verb: "Wrote a file" },
  Edit: { Icon: Pencil, verb: "Edited a file" },
  MultiEdit: { Icon: Pencil, verb: "Edited files" },
  NotebookEdit: { Icon: Pencil, verb: "Edited a notebook" },
  Bash: { Icon: Terminal, verb: "Ran a command" },
  Grep: { Icon: Search, verb: "Searched the code" },
  Glob: { Icon: Search, verb: "Looked for files" },
  WebFetch: { Icon: Globe, verb: "Fetched a page" },
  WebSearch: { Icon: Globe, verb: "Searched the web" },
  TodoWrite: { Icon: ListChecks, verb: "Updated the plan" },
};
/** Tools whose detail is a file path the agent changed — used to tally "files touched". */
export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function actMeta(tool: string): { Icon: LucideIcon; verb: string } {
  return ACT_META[tool] ?? { Icon: ChevronRight, verb: tool };
}

/** Icon for the non-`act` story kinds. */
export const KIND_ICON: Record<"say" | "final" | "subresult" | "delegate", LucideIcon> = {
  say: Lightbulb,
  final: Check,
  subresult: CornerDownRight,
  delegate: GitBranch,
};

/** Steer a parked branch back to a per-step checkpoint (AWAITING_APPROVAL only). */
export interface UndoCtl { checkpoints: Checkpoint[]; onUndo: (sha: string) => void }

/** One narrated step, in the timeline's stacked grammar: a typed glyph, a plain
 *  human line, and — for tool calls — the raw path/command dimmed beneath it. An
 *  edit step with a matching checkpoint gets a "rewind to here" affordance. */
export function StoryNode({ s, cp, onUndo }: { s: StoryItem; cp?: Checkpoint; onUndo?: (sha: string) => void }): JSX.Element {
  if (s.kind === "act") {
    const m = actMeta(s.tool);
    return (
      <div className="tl-node act">
        <span className="tl-glyph"><m.Icon size={13} /></span>
        <div className="tl-verb">
          {m.verb}
          {cp && onUndo && (
            <button className="tl-undo" title="Rewind the branch to this step — later changes are discarded"
              onClick={() => onUndo(cp.sha)}><Undo2 size={11} /> Rewind to here</button>
          )}
        </div>
        {s.detail && <div className="tl-detail mono">{s.detail}</div>}
      </div>
    );
  }
  const Icon = KIND_ICON[s.kind];
  const text = s.kind === "delegate"
    ? `Delegated to ${s.who}${s.mission ? ` — ${s.mission}` : ""}`
    : s.text;
  const label = s.kind === "say" ? "Thinking"
    : s.kind === "final" ? "Result"
    : s.kind === "subresult" ? "Sub-agent result" : "Delegated";
  return (
    <div className={`tl-node ${s.kind}`}>
      <span className="tl-glyph"><Icon size={13} /></span>
      <div className="tl-kind">{label}</div>
      <div className="tl-text">{text}</div>
    </div>
  );
}

/** A compact one-line tally of the run's footprint — tools invoked, distinct
 *  files the agent changed, and tokens spent — in the density of a status bar. */
export function StoryStats({ story, tokens }: { story: StoryItem[]; tokens: number }): JSX.Element | null {
  const acts = story.filter((s) => s.kind === "act") as Extract<StoryItem, { kind: "act" }>[];
  if (!acts.length && tokens <= 0) return null;
  const files = new Set(acts.filter((a) => EDIT_TOOLS.has(a.tool) && a.detail).map((a) => a.detail));
  const parts: string[] = [];
  if (acts.length) parts.push(`${acts.length} ${acts.length === 1 ? "tool" : "tools"}`);
  if (files.size) parts.push(`${files.size} ${files.size === 1 ? "file" : "files"}`);
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens`);
  return <div className="tl-foot mono">{parts.join(" · ")}</div>;
}

export function StoryView({ story, tokens = 0, undo }: { story: StoryItem[]; tokens?: number; undo?: UndoCtl }): JSX.Element {
  if (!story.length) return <p className="story-say">No activity recorded yet.</p>;
  // Checkpoints are recorded once per file-edit tool, oldest first — so the k-th
  // edit step maps to the k-th checkpoint. Track that index as we render.
  let editIdx = -1;
  return (
    <div className="tl">
      {story.map((s, i) => {
        let cp: Checkpoint | undefined;
        if (s.kind === "act" && EDIT_TOOLS.has(s.tool)) { editIdx++; cp = undo?.checkpoints[editIdx]; }
        return <StoryNode key={i} s={s} cp={cp} onUndo={undo?.onUndo} />;
      })}
      <StoryStats story={story} tokens={tokens} />
    </div>
  );
}
