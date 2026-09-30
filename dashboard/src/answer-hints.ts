/** Answering a blocked agent: the destructive-command hint and quick replies. */

export const DESTRUCTIVE_HINT = /\b(reset\s+--hard|--force|force-with-lease|git\s+rebase|git\s+clean|filter-branch|checkout\s+--)\b/i;

export const QUICK_REPLIES: Array<{ label: string; text: string }> = [
  { label: "Already done → no-op",
    text: "The ticket's change already exists in the repo. Do NOT reset, rebase, or "
      + "force anything. Report status \"done\" with \"noop\": true (already implemented)." },
  { label: "Don't rewrite history",
    text: "Do not run any destructive git command (reset --hard, rebase, force, clean). "
      + "Explain in one line what is actually missing, or report done/noop if nothing is." },
];
