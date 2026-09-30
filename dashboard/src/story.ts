/** Plain-language wording for run events and agent tool calls. */

import type { FactoryEvent } from "./types.js";
import { fmtUsd } from "./model.js";
import { Check, ChevronRight, CornerDownRight, FileText, GitBranch, Globe, Lightbulb, ListChecks, Pencil, Search, Terminal } from "./icons.js";
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
