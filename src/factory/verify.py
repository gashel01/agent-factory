"""Verification gate: a task's work only exists once it is proven.

Two layers, both deterministic:
1. the branch must contain real committed changes (an agent that "succeeds"
   without a diff is lying);
2. every success-criteria command must exit 0 inside the worktree.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .config import IntegrationConfig, VerifyConfig
from .task import Task
from .worktree import git

# A per-command runner: (cmd, cwd, timeout_s) -> (returncode, combined output).
# May raise subprocess.TimeoutExpired. The default runs on the host; sandbox mode
# injects one that runs each command inside the hardened box (offline).
CommandRunner = Callable[[str, Path, int], tuple[int, str]]


def _host_run(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
    # shell=True on purpose: commands are trusted user config ("pytest -q",
    # "npm test") and may rely on shell syntax.
    proc = subprocess.run(
        cmd, shell=True, cwd=str(cwd), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout_s,
    )
    return proc.returncode, proc.stdout + proc.stderr


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    failures: tuple[str, ...] = ()


def _run_commands(
    cwd: Path, commands: tuple[str, ...], timeout_s: int, runner: CommandRunner | None = None
) -> list[str]:
    """Run each command at cwd; collect a failure line per non-zero/timeout."""
    run = runner or _host_run
    failures: list[str] = []
    for cmd in commands:
        try:
            rc, out = run(cmd, cwd, timeout_s)
        except subprocess.TimeoutExpired:
            failures.append(f"`{cmd}` timed out after {timeout_s}s")
            continue
        if rc != 0:
            tail = out.strip().splitlines()[-8:]
            failures.append(f"`{cmd}` exited {rc}: " + " | ".join(tail))
    return failures


def run_verify(
    task: Task, worktree_path: Path, cfg: VerifyConfig, runner: CommandRunner | None = None
) -> VerifyResult:
    commits = git(worktree_path, "rev-list", "--count", f"{task.base_branch}..HEAD")
    if int(commits.stdout.strip() or 0) == 0:
        return VerifyResult(ok=False, failures=("no commits on the task branch",))
    diff = git(worktree_path, "diff", "--quiet", f"{task.base_branch}..HEAD", check=False)
    if diff.returncode == 0:
        return VerifyResult(ok=False, failures=("commits present but the diff is empty",))

    commands = task.verify_commands or cfg.commands
    # The git checks above stay on the host (fast, deterministic reads); only the
    # success-criteria commands — which execute the agent's own code — run in the
    # box when a runner is injected.
    failures = _run_commands(worktree_path, commands, cfg.command_timeout_s, runner)
    return VerifyResult(ok=not failures, failures=tuple(failures))


def run_integration(repo: Path, cfg: IntegrationConfig) -> VerifyResult:
    """Run the integration suite once at the repo root (the base branch, after all
    merges have landed). Proves the merged tickets hold together, not just each
    in isolation."""
    failures = _run_commands(repo, cfg.commands, cfg.command_timeout_s)
    return VerifyResult(ok=not failures, failures=tuple(failures))
