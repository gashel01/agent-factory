"""Claude Code hooks Warden injects into every coding agent (and the supervisor).

Deliberately standalone — standard library only, no `factory` imports — because
the same file runs in two places: on the host (direct isolation) and inside the
sandbox container, which has python3 and git but not Warden. Mounted read-only
there, it is invoked by path in both cases:

    python agent_hooks.py guard [--role agent|supervisor]   # PreToolUse
    python agent_hooks.py checkpoint                        # PostToolUse

`guard` is a safety floor against ACCIDENTS, not a sandbox. The CLI's own
`--disallowedTools` only matches a command's prefix, so `bash -c "git reset
--hard"` or a Python `subprocess.run(["git", "rebase", ...])` sailed past it. A
PreToolUse hook sees every call — allow-listed ones included — so the whole
command text is scanned, whatever wraps it. An agent determined to evade a text
scan still can (that is what `isolation: sandbox` is for); an agent that reaches
for `git reset --hard` in frustration, which is the failure seen in practice,
is stopped and told why.

Exit code 2 blocks the call and hands stderr to the model (Claude Code's hook
contract). Anything unexpected exits 0: a broken hook must not brick the agent.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import PurePath

#: Must match factory.checkpoint.CHECKPOINT_MARK (asserted by a test): the
#: dashboard lists checkpoint commits by this subject prefix.
CHECKPOINT_MARK = "warden-checkpoint"

# Quotes, list punctuation and call parentheses are what a command gets wrapped
# in (`bash -c "…"`, `["git", "reset"]`, `os.system('…')`). Blanking them turns
# every wrapping into the plain word sequence the rules below read.
_WRAPPING = re.compile(r"""[\'"`,\[\](){}]""")
# Command separators: each segment is judged on its own.
_SEGMENTS = re.compile(r";|&&|\|\||\||\n")
# git's global options that may sit between `git` and the subcommand.
_GLOBAL_OPT_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}

_GIT_CONFIG_EXEC_KEYS = (
    "core.hookspath", "core.fsmonitor", "core.sshcommand", "core.editor",
    "core.pager", "alias.", "diff.external", "filter.", "credential.helper",
)


def _git_invocations(command: str) -> list[list[str]]:
    """Every `git …` word sequence in a shell command, wrappers stripped."""
    found: list[list[str]] = []
    for segment in _SEGMENTS.split(_WRAPPING.sub(" ", command)):
        words = segment.split()
        for i, word in enumerate(words):
            if PurePath(word).name in ("git", "git.exe"):
                found.append(words[i + 1:])
    return found


def _subcommand(args: list[str]) -> tuple[str, list[str]]:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        opt = args[i].split("=", 1)[0]
        i += 2 if opt in _GLOBAL_OPT_WITH_VALUE and "=" not in args[i] else 1
    if i >= len(args):
        return "", []
    return args[i], args[i + 1:]


def destructive_git_reason(command: str) -> str | None:
    """Why this shell command must not run, or None when it is fine."""
    for invocation in _git_invocations(command):
        sub, rest = _subcommand(invocation)
        flags = set(rest)
        if sub == "reset" and flags & {"--hard", "--keep", "--merge"}:
            return "git reset --hard/--keep/--merge discards work"
        if sub == "push" and (
            flags & {"-f", "--force", "--force-with-lease", "--mirror", "--delete", "-d"}
            or any(r.startswith("+") or r.startswith(":") for r in rest)
        ):
            return "force-pushing or deleting remote refs rewrites shared history"
        if sub in ("rebase", "filter-branch", "filter-repo", "replace", "update-ref"):
            return f"git {sub} rewrites history or refs"
        if sub == "clean":
            return "git clean deletes untracked files"
        if sub == "checkout" and ("--" in rest or "." in rest or "-f" in rest):
            return "git checkout -- / . / -f discards uncommitted changes"
        if sub == "restore" and not flags & {"--staged", "-S"}:
            return "git restore discards uncommitted changes"
        if sub == "branch" and flags & {"-D", "-d", "--delete", "-M", "-m", "--move", "-f"}:
            return "deleting or renaming branches is the operator's call"
        if sub == "stash" and rest[:1] in (["drop"], ["clear"]):
            return "dropping a stash destroys work"
        if sub == "worktree" and rest[:1] in (["remove"], ["prune"], ["move"]):
            return "worktrees are managed by Warden"
        if sub == "config" and any(
            r.lower().startswith(_GIT_CONFIG_EXEC_KEYS) for r in rest
        ):
            return "that git setting runs commands; it is not yours to change"
    return None


# Writing into git's own directory (hooks, config, refs) is how a tree turns into
# code execution for whoever runs git there next — the host included.
_DOTGIT_WRITE = re.compile(
    r"(?:\b(?:rm|mv|cp|tee|ln|chmod|truncate|install)\b[^;&|\n]*|>>?\s*)"
    r"(?:\S*[/\\])?\.git(?:[/\\]|\s|$)"
)


def _touches_dotgit(path: str) -> bool:
    return ".git" in PurePath(path.replace("\\", "/")).parts


def guard(payload: dict, role: str) -> str | None:
    """The block reason for one tool call, or None to let it through."""
    tool = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    target = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
    if role == "supervisor":
        # The supervisor reads untrusted text (agent summaries). Its actions on the
        # run go through suggestions the operator clicks, never straight into the
        # control channel.
        if tool in ("Write", "Edit", "MultiEdit") and PurePath(
            target.replace("\\", "/")
        ).name == "control.jsonl":
            return ("the control channel is operator-only: propose the action as a "
                    "suggestion instead, the operator applies it with one click")
        return None
    if tool == "Bash":
        command = str(tool_input.get("command", ""))
        reason = destructive_git_reason(command)
        if reason is None and _DOTGIT_WRITE.search(command):
            reason = "writing inside .git is off-limits"
        return reason
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit") and _touches_dotgit(target):
        return "writing inside .git is off-limits"
    return None


def _run_guard(argv: list[str]) -> int:
    role = argv[argv.index("--role") + 1] if "--role" in argv[:-1] else "agent"
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 0
    if not isinstance(payload, dict):
        return 0
    reason = guard(payload, role)
    if reason is None:
        return 0
    print(
        f"Blocked by Warden: {reason}. If this step is genuinely necessary to finish "
        "the ticket, stop and report status \"blocked\" explaining why — the operator "
        "will decide and act.",
        file=sys.stderr,
    )
    return 2


def _run_checkpoint() -> int:
    """Commit the working tree as an undo checkpoint (sandbox runtime; the host
    uses `factory checkpoint`, same subject format). Never fails the turn."""
    label = ""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        tool_input = payload.get("tool_input") or {}
        target = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
        label = " ".join(p for p in (str(payload.get("tool_name", "")),
                                     PurePath(target).name if target else "") if p)
    except Exception:  # noqa: BLE001 — a malformed payload just means a blank label
        label = ""
    subject = f"{CHECKPOINT_MARK}: {label}" if label else CHECKPOINT_MARK
    try:
        subprocess.run(["git", "add", "-A"], capture_output=True, timeout=60)
        staged = subprocess.run(["git", "diff", "--cached", "--quiet"], timeout=60)
        if staged.returncode != 0:
            subprocess.run(["git", "commit", "-q", "--no-verify", "-m", subject[:200]],
                           capture_output=True, timeout=60)
    except Exception:  # noqa: BLE001 — bookkeeping must never break the agent's turn
        pass
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["guard"]:
        return _run_guard(argv[1:])
    if argv[:1] == ["checkpoint"]:
        return _run_checkpoint()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
