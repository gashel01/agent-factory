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
    # True when the rebase actually replayed commits and we re-ran verify; False
    # when the base had not moved under this branch, so the agent's own verify
    # still held and the redundant re-run was skipped. Observable in the log.
    reverified: bool = True
    # Non-fatal note surfaced on a SUCCESSFUL merge — e.g. the operator's stashed
    # work-in-progress collided with the merged ticket on restore. The merge landed;
    # this tells them a manual reconcile is waiting in their checkout.
    warning: str = ""


def merge_branch(task: Task, wt: Worktree, verify_cfg: VerifyConfig) -> MergeResult:
    head_before = git(wt.path, "rev-parse", "HEAD", check=False).stdout.strip()
    rebase = git(wt.path, "rebase", task.base_branch, check=False)
    if rebase.returncode != 0:
        git(wt.path, "rebase", "--abort", check=False)
        detail = (rebase.stderr or rebase.stdout).strip().splitlines()[-5:]
        return MergeResult(ok=False, reason="rebase conflict: " + " | ".join(detail))

    # Re-verify ONLY when the world actually moved: a rebase that replays nothing
    # (the branch head is unchanged) means the base had no new commits under this
    # ticket, so the deterministic verify the dispatcher already ran still holds.
    # Skipping it here removes a full second verify pass (tsc/pytest on the whole
    # project) from the common case where a ticket lands before its siblings.
    head_after = git(wt.path, "rev-parse", "HEAD", check=False).stdout.strip()
    reverified = head_after != head_before
    if reverified:
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

    # The base checkout can be dirty — the operator may be editing it in parallel.
    # Rather than refuse (and lose the merge), set their work-in-progress aside so
    # the merge lands on a clean tree, then restore it on top. Stashing is safe:
    # a failed stash defers the merge instead of touching their files.
    stashed = False
    if not is_clean(wt.repo):
        st = git(wt.repo, "stash", "push", "--include-untracked",
                 "-m", f"factory-auto {task.id}", check=False)
        if st.returncode != 0 or not is_clean(wt.repo):
            git(wt.repo, "stash", "pop", check=False)  # undo a partial stash
            return MergeResult(
                ok=False,
                reason="base checkout is dirty and could not be set aside; merge deferred",
            )
        stashed = True

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
        if stashed:
            git(wt.repo, "stash", "pop", check=False)  # base unchanged: restore WIP cleanly
        detail = (merge.stderr or merge.stdout).strip().splitlines()[-5:]
        return MergeResult(ok=False, reason="merge failed: " + " | ".join(detail))

    warning = ""
    if stashed:
        # Restore the operator's WIP onto the just-advanced base (a real 3-way merge).
        # A conflict here means they edited the very lines the ticket changed — the
        # merge still LANDED; git keeps the stash, so their work is recoverable.
        pop = git(wt.repo, "stash", "pop", check=False)
        if pop.returncode != 0:
            warning = (
                "merged, but your uncommitted edits overlap the ticket's changes — "
                "resolve the conflict in your checkout (your work is safe in `git stash`)"
            )

    remove(wt, delete_branch=True)
    return MergeResult(
        ok=True, base_sha=base_sha, head_sha=head_sha, reverified=reverified, warning=warning
    )


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

    head_before = git(wt.path, "rev-parse", "HEAD", check=False).stdout.strip()
    rebase = git(wt.path, "rebase", task.base_branch, check=False)
    if rebase.returncode != 0:
        git(wt.path, "rebase", "--abort", check=False)
        detail = (rebase.stderr or rebase.stdout).strip().splitlines()[-5:]
        return PrResult(ok=False, reason="rebase conflict: " + " | ".join(detail))

    # Only re-verify when the rebase actually replayed commits (see merge_branch):
    # an unchanged branch head means the base did not move, so the earlier verify holds.
    head_after = git(wt.path, "rev-parse", "HEAD", check=False).stdout.strip()
    if head_after != head_before:
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
