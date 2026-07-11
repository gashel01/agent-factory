"""Sequential merge queue: rebase on base, re-verify (the world moved), then merge.

Merges are strictly one-at-a-time and re-verified after rebase — a branch that was
green in isolation may be red once its siblings have landed.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import VerifyConfig
from .task import Task
from .verify import run_verify
from .worktree import Worktree, current_branch, git, is_clean, remove


@dataclass(frozen=True)
class MergeResult:
    ok: bool
    reason: str = ""


def merge_branch(task: Task, wt: Worktree, verify_cfg: VerifyConfig) -> MergeResult:
    rebase = git(wt.path, "rebase", task.base_branch, check=False)
    if rebase.returncode != 0:
        git(wt.path, "rebase", "--abort", check=False)
        detail = (rebase.stderr or rebase.stdout).strip().splitlines()[-5:]
        return MergeResult(ok=False, reason="rebase conflict: " + " | ".join(detail))

    reverify = run_verify(task, wt.path, verify_cfg)
    if not reverify.ok:
        reason = "post-rebase verify failed: " + "; ".join(reverify.failures)
        return MergeResult(ok=False, reason=reason)

    branch = current_branch(wt.repo)
    if branch != task.base_branch:
        return MergeResult(
            ok=False,
            reason=f"repo is on '{branch}', expected '{task.base_branch}' (preflight drift)",
        )
    if not is_clean(wt.repo):
        return MergeResult(ok=False, reason="repo has uncommitted changes; merge refused")

    merge = git(
        wt.repo,
        "merge",
        "--no-ff",
        wt.branch,
        "-m",
        f"Merge {wt.branch}: {task.title}",
        check=False,
    )
    if merge.returncode != 0:
        git(wt.repo, "merge", "--abort", check=False)
        detail = (merge.stderr or merge.stdout).strip().splitlines()[-5:]
        return MergeResult(ok=False, reason="merge failed: " + " | ".join(detail))

    remove(wt, delete_branch=True)
    return MergeResult(ok=True)
