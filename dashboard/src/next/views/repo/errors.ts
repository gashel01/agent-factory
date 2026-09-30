/** Turn a failed repo / GitHub request into plain words.
 *
 *  The server forwards git's and gh's own output on failure ("fatal: bad object
 *  1a2b3c", "error: Your local changes…", a gh usage dump). Those are right for a
 *  terminal and wrong for a page: this maps the cases people actually hit to one
 *  sentence, keeps Warden's own (already human) messages, and falls back to the
 *  caller's wording for anything else. The raw text is still available to the
 *  caller as `raw` (shown as a tooltip, never as the message). */

const KNOWN: Array<[RegExp, string]> = [
  [/request timed out/i, "Warden took too long to answer — try again."],
  [/failed to fetch|networkerror|could not reach/i, "Couldn't reach Warden — is the server still running?"],
  [/not a repository of a registered project/i, "This folder isn't the repository of a registered project."],
  [/must be an existing git repository|not a git repository/i, "This folder isn't a git repository yet."],
  [/bad object|unknown revision|bad revision|invalid object name|ambiguous argument/i,
    "Those commits are no longer in the repository (rewritten or deleted) — nothing to show."],
  [/would be overwritten|local changes/i, "You have uncommitted changes this would overwrite — commit or stash them first."],
  [/repo path does not exist/i, "The repository folder doesn't exist on this machine any more."],
  [/does not exist in|exists on disk, but not in/i, "That file isn't on this branch — it may have been moved or deleted."],
  [/already exists/i, "A branch with that name already exists."],
  [/not fully merged/i, "That branch has work that isn't merged anywhere yet."],
  [/spawn gh ENOENT|gh unavailable|'gh' is not recognized/i, "The GitHub CLI (gh) isn't installed on this machine."],
  [/gh auth login|not logged in|authentication/i, "The GitHub CLI isn't logged in — run `gh auth login` once."],
  [/no git remotes|none of the git remotes|could not determine|no default remote/i, "This repository has no GitHub remote yet."],
  [/unreadable gh output/i, "GitHub answered something Warden couldn't read — try again."],
  [/push failed/i, "The branch couldn't be pushed to GitHub (no remote, or it was rejected)."],
  [/merge conflict|not mergeable|conflict/i, "GitHub can't merge it cleanly — there are conflicts to resolve first."],
];

/** Warden's own messages are single short sentences without a git/gh prefix. */
function looksHuman(msg: string): boolean {
  return msg.length > 0 && msg.length < 160 && !msg.includes("\n") && !/^(fatal|error|usage|warning|hint):/i.test(msg)
    && !/^HTTP \d/.test(msg);
}

export function plainError(err: unknown, fallback: string): { text: string; raw: string } {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).replace(/^Error:\s*/, "").trim();
  for (const [re, text] of KNOWN) if (re.test(raw)) return { text, raw };
  return { text: looksHuman(raw) ? raw : fallback, raw };
}

/** A diff body the server returned with status 200 but that is really git's error. */
export function diffFailure(text: string): string | null {
  const head = text.trimStart().slice(0, 400);
  if (/^(fatal|error):/im.test(head)) return plainError(head, "Git couldn't produce this diff.").text;
  return null;
}
