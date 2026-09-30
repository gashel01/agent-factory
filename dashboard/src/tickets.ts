/** Ticket files: front-matter read/write, title and body, plus the small
 *  helpers the planner and supervisor views share. */

import { BookOpen, Folder, Lightbulb, Search } from "./icons.js";
import type { LucideIcon } from "./icons.js";


export interface Ticket { file: string; content: string }
/* ---- ticket front-matter helpers: read/patch one scalar key without touching
   the rest of the file, so the per-ticket pickers below can tune `model:` and
   `effort:` while hand-written YAML stays intact. ---- */

export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function fmGet(content: string, key: string): string {
  const fm = FM_RE.exec(content)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*["']?([\\w.-]+)["']?\\s*$`, "m").exec(fm)?.[1] ?? "";
}

export function fmSet(content: string, key: string, value: string): string {
  const m = FM_RE.exec(content);
  if (!m) return content;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !l.startsWith(`${key}:`));
  if (value) kept.push(`${key}: ${value}`);
  return content.replace(m[0], `---\n${kept.join("\n")}\n---`);
}

export function ticketTitle(content: string): string {
  const m = content.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : "(untitled)";
}

/** The ticket body — everything after the front matter block. */
export function ticketBody(content: string): string {
  const m = FM_RE.exec(content);
  return (m ? content.slice(m[0].length) : content).replace(/^\r?\n/, "");
}

/** Rewrite a ticket's title (front matter) and body, preserving every other flag
 *  already on it (assignee, status, hold, model, effort, skip_*). */
export function withTitleAndBody(content: string, title: string, body: string): string {
  const q = `"${title.replace(/"/g, "'")}"`;
  const m = FM_RE.exec(content);
  if (!m) return `---\ntitle: ${q}\n---\n${body.trim()}\n`;
  const kept = m[1]!.split(/\r?\n/).filter((l) => !/^title:\s*/.test(l));
  const idIdx = kept.findIndex((l) => /^id:\s*/.test(l));
  kept.splice(idIdx >= 0 ? idIdx + 1 : 0, 0, `title: ${q}`);
  return `---\n${kept.join("\n")}\n---\n${body.trim()}\n`;
}

/** Relative "2m ago" style stamp for a companion observation. */
export function agoShort(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Icon for one planner activity line, keyed off the verb describe_step emits. */
export function stepIcon(step: string): LucideIcon {
  if (step.startsWith("reading ")) return BookOpen;
  if (step.startsWith("searching")) return Search;
  if (step.startsWith("finding files")) return Folder;
  return Lightbulb;
}

export interface PlanQuestion { q: string; why: string; suggestions: string[] }
