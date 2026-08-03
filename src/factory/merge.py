"""Sequential merge queue: rebase on base, re-verify (the world moved), then merge.

Merges are strictly one-at-a-time and re-verified after rebase — a branch that was
green in isolation may be red once its siblings have landed.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from .config import VerifyConfig
from .task import Task
from .verify import run_verify
from .worktree import Worktree, current_branch, git, is_clean, push_branch, remotes, remove


@dataclass(frozen=True)
class MergeResult:
    ok: bool
    reason: str = ""
    # SHAs bracketing the ticket's changes, so the dashboard can show its diff
    # after the branch is gone: git diff base_sha..head_sha == the ticket's work.
    base_sha: str = ""
    head_sha: str = ""


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

    # Capture the range before the branch is deleted; both commits stay reachable
    # from the --no-ff merge commit, so the diff survives.
    base_sha = git(wt.repo, "rev-parse", task.base_branch, check=False).stdout.strip()
    head_sha = git(wt.repo, "rev-parse", wt.branch, check=False).stdout.strip()

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
    return MergeResult(ok=True, base_sha=base_sha, head_sha=head_sha)


@dataclass(frozen=True)
class PrResult:
    ok: bool
    reason: str = ""
    url: str = ""


def deliver_pr(task: Task, wt: Worktree, verify_cfg: VerifyConfig) -> PrResult:
    """PR-native landing: rebase on base, re-verify, then push the branch and open
    a GitHub PR instead of merging locally. The base stays untouched — GitHub (and
    its CI) owns the merge."""
    if not shutil.which("gh"):
        return PrResult(
            ok=False, reason="PR mode needs the GitHub CLI (`gh`) installed and authenticated"
        )
    if not remotes(wt.repo):
        return PrResult(ok=False, reason="PR mode needs a git remote (origin); this repo has none")

    rebase = git(wt.path, "rebase", task.base_branch, check=False)
    if rebase.returncode != 0:
        git(wt.path, "rebase", "--abort", check=False)
        detail = (rebase.stderr or rebase.stdout).strip().splitlines()[-5:]
        return PrResult(ok=False, reason="rebase conflict: " + " | ".join(detail))

    reverify = run_verify(task, wt.path, verify_cfg)
    if not reverify.ok:
        return PrResult(
            ok=False, reason="post-rebase verify failed: " + "; ".join(reverify.failures)
        )

    try:
        push_branch(wt.repo, wt.branch)
    except Exception as exc:  # noqa: BLE001
        return PrResult(ok=False, reason=f"push failed: {exc}")

    body = (
        f"Ticket **{task.id}** — {task.title}\n\n"
        f"Opened by Agent Factory. Verified before push; review and merge on GitHub."
    )
    proc = subprocess.run(
        ["gh", "pr", "create", "--base", task.base_branch, "--head", wt.branch,
         "--title", f"{task.id}: {task.title}", "--body", body],
        cwd=str(wt.repo), capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()[-5:]
        return PrResult(ok=False, reason="gh pr create failed: " + " | ".join(detail))
    url = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""

    # The branch lives on origin for the PR; drop only the local worktree + ref.
    remove(wt, delete_branch=True)
    return PrResult(ok=True, url=url)
