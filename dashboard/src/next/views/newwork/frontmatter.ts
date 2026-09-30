/** Ticket front-matter helpers the classic fmGet/fmSet can't cover.
 *
 *  fmGet/fmSet (work.ts) handle one-word scalars (model: haiku). A ticket's
 *  `verify` is a list of shell commands — the planner writes it as a JSON flow
 *  list (`verify: ["pytest -q"]`), a hand-written ticket may use a plain string
 *  or a block list — so reading and writing it needs its own care. Everything
 *  else on the ticket is preserved byte for byte. */

import { FM_RE } from "../../../tickets.js";

/** Split "a, b" into commands, the same way Settings reads its command lists. */
export function splitCommands(text: string): string[] {
  return text.split(",").map((c) => c.trim()).filter(Boolean);
}

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

/** The ticket's own verify commands (empty = it inherits the project's defaults). */
export function verifyGet(content: string): string[] {
  const fm = FM_RE.exec(content)?.[1];
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => /^verify:/.test(l));
  if (at < 0) return [];
  const inline = lines[at]!.slice("verify:".length).trim();
  if (inline.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(inline);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* single-quoted YAML flow list: fall through to the regex */ }
    return [...inline.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "").filter(Boolean);
  }
  if (inline) return [unquote(inline)];
  // Block list: the indented "- cmd" lines right under `verify:`.
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(unquote(m[1]!));
  }
  return out.filter(Boolean);
}

/** Replace the ticket's verify commands (an empty list removes the key). */
export function verifySet(content: string, commands: string[]): string {
  const m = FM_RE.exec(content);
  if (!m) return content;
  const lines = m[1]!.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^verify:/.test(lines[i]!)) {
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) i++; // drop its block items
      continue;
    }
    kept.push(lines[i]!);
  }
  if (commands.length) kept.push(`verify: ${JSON.stringify(commands)}`);
  return content.replace(m[0], `---\n${kept.join("\n")}\n---`);
}

/** Next free ticket number ("004"). It must clear the backlog AND every run
 *  task id: after a run the backlog is empty, so counting it alone would reuse
 *  "001" — which collides with a merged task and hides the new draft. */
export function nextTicketId(files: string[], takenIds: string[]): string {
  const fromFiles = files.map((f) => Number((/^(\d+)/.exec(f) ?? [])[1]));
  const fromTasks = takenIds.map((id) => Number((/(\d+)/.exec(id) ?? [])[1]));
  const nums = [...fromFiles, ...fromTasks].filter((n) => !Number.isNaN(n));
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
}

export function ticketSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ticket";
}

/** A new hand-written ticket, in the same shape the classic "Add to Up next" writes. */
export function newTicketContent(o: {
  id: string; title: string; repo: string; body: string;
  verify: string[]; model: string; skipVerify: boolean;
}): string {
  const fm = [
    `id: "${o.id}"`,
    `title: "${o.title.replace(/"/g, "'")}"`,
    `repo: ${o.repo}`,
    ...(o.model ? [`model: ${o.model}`] : []),
    ...(o.verify.length ? [`verify: ${JSON.stringify(o.verify)}`] : []),
    ...(o.skipVerify ? ["skip_verify: true"] : []),
  ];
  const body = o.body.trim() || "## Goal\nDescribe what to build.\n\n## Done when\n- ";
  return `---\n${fm.join("\n")}\n---\n${body}\n`;
}
