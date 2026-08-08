"""Per-tool worktree checkpoints, so a single step can be individually undone.

Opt-in (``agent.checkpoints``). When enabled, the agent runs behind a Claude Code
``PostToolUse`` hook that commits the worktree after each file edit, tagging the
commit with :data:`CHECKPOINT_MARK`. The dashboard lists those commits against the
narrated steps and offers "undo to here", which resets the agent's scratch branch
back to a chosen checkpoint.

Why a reset is safe here: the branch being reset is the agent's own un-merged
worktree branch. It is never shared history until it clears the verify gate and
merges, so rewinding it destroys nothing anyone else can see. (This is the same
reason the agent itself is forbidden ``git reset --hard`` — it must never be able
to rewind history on its own; only the operator, through Warden, can.)

The helpers here are pure git plumbing over :func:`factory.worktree.git`, kept in
one module so they can be unit-tested against a throwaway repo without spawning an
agent.
"""

from __future__ import annotations

from pathlib import Path

from .worktree import git

#: Subject prefix that marks a commit as a Warden checkpoint (vs. the agent's own
#: commits or the base history). Distinctive enough to never collide by accident.
CHECKPOINT_MARK = "warden-checkpoint"


def make_checkpoint(repo: Path, label: str = "") -> str | None:
    """Stage everything in ``repo`` and commit it as a checkpoint.

    Returns the new commit SHA, or ``None`` when there was nothing to record (no
    changes since the previous checkpoint) — a no-op, never an error, so the hook
    stays quiet on tool calls that touched no files.
    """
    git(repo, "add", "-A", check=False)
    status = git(repo, "status", "--porcelain", check=False)
    if not status.stdout.strip():
        return None
    subject = f"{CHECKPOINT_MARK}: {label.strip()}" if label.strip() else CHECKPOINT_MARK
    # --no-verify: never let a project's pre-commit hook block a checkpoint (it is
    # Warden's bookkeeping, not the agent's deliverable). One line, capped.
    commit = git(repo, "commit", "-q", "--no-verify", "-m", subject[:200], check=False)
    if commit.returncode != 0:
        return None
    head = git(repo, "rev-parse", "HEAD", check=False)
    return head.stdout.strip() or None


def list_checkpoints(repo: Path, base: str) -> list[dict[str, str]]:
    """Checkpoints on the current branch since ``base``, oldest first.

    Each entry is ``{"sha", "short", "label"}``. Non-checkpoint commits (the base
    history, the agent's own commits) are skipped so the list maps cleanly onto the
    narrated edit steps.
    """
    log = git(repo, "log", "--reverse", "--format=%H%x1f%s", f"{base}..HEAD", check=False)
    out: list[dict[str, str]] = []
    for line in log.stdout.splitlines():
        if "\x1f" not in line:
            continue
        sha, subject = line.split("\x1f", 1)
        if not subject.startswith(CHECKPOINT_MARK):
            continue
        label = subject[len(CHECKPOINT_MARK):].lstrip(": ").strip()
        out.append({"sha": sha, "short": sha[:8], "label": label})
    return out


def undo_to(repo: Path, sha: str) -> None:
    """Reset the worktree's branch back to checkpoint ``sha`` (hard).

    Raises :class:`factory.worktree.GitError` if the SHA is unknown or the reset
    fails. The caller must ensure no agent is actively editing the worktree, so the
    rewind can't race a live turn.
    """
    git(repo, "reset", "--hard", sha)
