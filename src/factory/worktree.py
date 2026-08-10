"""Git worktree isolation: one worktree + one branch per task, cleaned up afterwards."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# A per-command runner: (cmd, cwd, timeout_s) -> (returncode, combined output).
# May raise subprocess.TimeoutExpired. Default runs on the host; sandbox mode
# injects one that installs dependencies inside the box (see factory/sandbox.py).
CommandRunner = Callable[[str, Path, int], tuple[int, str]]


class SetupError(Exception):
    """A post-worktree setup command failed; message carries the evidence."""


def _host_run(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
    # shell=True on purpose: commands are trusted user config ("uv sync",
    # "npm ci") and may rely on shell syntax.
    proc = subprocess.run(
        cmd, shell=True, cwd=str(cwd), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout_s,
    )
    return proc.returncode, proc.stdout + proc.stderr


def run_setup(
    wt_path: Path, commands: tuple[str, ...], timeout_s: int, runner: CommandRunner | None = None
) -> None:
    """Run dependency-installation commands inside a fresh worktree.

    Default runs on the host; in sandbox mode the injected runner installs deps
    inside the container so the agent's build environment matches where it runs.
    """
    run = runner or _host_run
    for cmd in commands:
        try:
            rc, out = run(cmd, wt_path, timeout_s)
        except subprocess.TimeoutExpired as exc:
            raise SetupError(f"setup `{cmd}` timed out after {timeout_s}s") from exc
        if rc != 0:
            tail = out.strip().splitlines()[-8:]
            raise SetupError(f"setup `{cmd}` exited {rc}: " + " | ".join(tail))


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


def remotes(repo: Path) -> list[str]:
    return [r for r in git(repo, "remote", check=False).stdout.split() if r]


def fetch(repo: Path) -> None:
    """Best-effort refresh of remote-tracking refs; offline/no-remote is not fatal."""
    git(repo, "fetch", "--quiet", check=False)


def ahead_behind(repo: Path, base_branch: str) -> tuple[int, int] | None:
    """(ahead, behind) of the local base vs origin/<base>. None if there is no
    such upstream (no remote, or the branch was never pushed)."""
    res = git(
        repo, "rev-list", "--left-right", "--count",
        f"{base_branch}...origin/{base_branch}", check=False,
    )
    if res.returncode != 0:
        return None
    parts = res.stdout.split()
    if len(parts) != 2:
        return None
    return int(parts[0]), int(parts[1])  # ahead, behind


def pull_ff(repo: Path, base_branch: str) -> bool:
    """Fast-forward the checked-out base to origin/<base>. Returns True if it moved.
    Never forces: a diverged base is left alone (the caller only pulls when behind
    and not ahead)."""
    before = git(repo, "rev-parse", "HEAD", check=False).stdout.strip()
    git(repo, "merge", "--ff-only", f"origin/{base_branch}", check=False)
    after = git(repo, "rev-parse", "HEAD", check=False).stdout.strip()
    return before != after


def push_branch(repo: Path, branch: str) -> None:
    """Push a task branch to origin so a PR can be opened from it. force-with-lease
    handles a re-run that reuses the same branch name without clobbering others."""
    git(repo, "push", "--force-with-lease", "-u", "origin", branch)


def ensure_base_checked_out(repo: Path, branch: str) -> None:
    """Make <branch> the checked-out base of <repo>, creating it from the current
    HEAD if it does not exist. Lets a run target a fresh integration branch without
    the operator ever touching git — but never clobbers uncommitted work: a dirty
    tree raises with an actionable message instead of switching under it."""
    if current_branch(repo) == branch:
        return
    if not is_clean(repo):
        raise GitError(
            ("switch",),
            f"{repo} has uncommitted changes — commit or stash them before "
            f"delivering to '{branch}', or deliver onto the current branch instead.",
        )
    exists = git(
        repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False
    ).returncode == 0
    if exists:
        git(repo, "switch", branch)
    else:
        git(repo, "switch", "-c", branch)


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
