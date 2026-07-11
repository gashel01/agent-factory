"""Git worktree isolation: one worktree + one branch per task, cleaned up afterwards."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitError(Exception):
    def __init__(self, args_: tuple[str, ...], stderr: str):
        self.stderr = stderr.strip()
        super().__init__(f"git {' '.join(args_)} failed: {self.stderr}")


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        raise GitError(args, proc.stderr or proc.stdout)
    return proc


@dataclass(frozen=True)
class Worktree:
    path: Path
    branch: str
    repo: Path


def create(repo: Path, wt_root: Path, run_id: str, task_id: str, base_branch: str) -> Worktree:
    wt_root.mkdir(parents=True, exist_ok=True)
    path = wt_root / task_id  # short path: Windows path-length budget matters here
    branch = f"agent/{run_id}/{task_id}"
    git(repo, "worktree", "add", str(path), "-b", branch, base_branch)
    return Worktree(path=path, branch=branch, repo=repo)


def remove(wt: Worktree, *, delete_branch: bool) -> None:
    git(wt.repo, "worktree", "remove", "--force", str(wt.path), check=False)
    if delete_branch:
        git(wt.repo, "branch", "-D", wt.branch, check=False)


def prune(repo: Path) -> None:
    git(repo, "worktree", "prune")


def current_branch(repo: Path) -> str:
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()


def is_clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain").stdout.strip() == ""


def preflight(repo: Path, base_branch: str) -> None:
    """Fail fast, with an actionable message, before any agent is spawned."""
    if not (repo / ".git").exists():
        raise GitError(("preflight",), f"{repo} is not a git repository")
    branch = current_branch(repo)
    if branch != base_branch:
        raise GitError(
            ("preflight",),
            f"{repo} is on '{branch}', expected '{base_branch}'. "
            f"The merge queue targets the checked-out base branch.",
        )
    if not is_clean(repo):
        raise GitError(
            ("preflight",),
            f"{repo} has uncommitted changes. Commit or stash them before a run.",
        )
