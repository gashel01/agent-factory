/** /api/repo/diff answers 200 with git's own output even when git failed (the
 *  route returns whatever `git diff` printed). A diff whose commits are gone
 *  therefore arrives as "fatal: Invalid revision range a..b". This turns such
 *  output into a sentence a person can act on; null means it is a real diff. */

export interface PlainGitError { title: string; detail: string }

export function plainGitError(text: string): PlainGitError | null {
  const head = text.trimStart().slice(0, 400);
  if (!/^(fatal|error|usage):|^Error: spawn/im.test(head) || /^diff --git/m.test(text)) return null;
  if (/invalid revision range|unknown revision|bad revision|bad object|ambiguous argument|not a valid object/i.test(head)) {
    return {
      title: "The commits behind this change are gone",
      detail: "This ticket's commits are no longer in the repository — it was likely re-cloned, rebuilt or its history rewritten. "
        + "The work itself isn't affected; only its diff can't be shown any more.",
    };
  }
  if (/not a git repository/i.test(head)) {
    return {
      title: "The project folder is no longer a git repository",
      detail: "The repository this ticket worked in has moved or lost its .git folder, so its changes can't be read.",
    };
  }
  if (/cannot change to|no such file or directory|ENOENT/i.test(head)) {
    return { title: "The repository can't be read", detail: "The folder this ticket worked in no longer exists here, or git isn't available to the Warden server." };
  }
  return { title: "Git couldn't produce this diff", detail: "The repository refused to compare this ticket's commits." };
}
