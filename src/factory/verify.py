"""Verification gate: a task's work only exists once it is proven.

Two layers, both deterministic:
1. the branch must contain real committed changes (an agent that "succeeds"
   without a diff is lying);
2. every success-criteria command must exit 0 inside the worktree.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import VerifyConfig
from .task import Task
from .worktree import git


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    failures: tuple[str, ...] = ()


def run_verify(task: Task, worktree_path: Path, cfg: VerifyConfig) -> VerifyResult:
    failures: list[str] = []

    commits = git(worktree_path, "rev-list", "--count", f"{task.base_branch}..HEAD")
    if int(commits.stdout.strip() or 0) == 0:
        return VerifyResult(ok=False, failures=("no commits on the task branch",))
    diff = git(worktree_path, "diff", "--quiet", f"{task.base_branch}..HEAD", check=False)
    if diff.returncode == 0:
        return VerifyResult(ok=False, failures=("commits present but the diff is empty",))

    commands = task.verify_commands or cfg.commands
    for cmd in commands:
        try:
            # shell=True on purpose: commands are trusted user config
            # ("pytest -q", "npm test") and may rely on shell syntax.
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=str(worktree_path),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=cfg.command_timeout_s,
            )
        except subprocess.TimeoutExpired:
            failures.append(f"`{cmd}` timed out after {cfg.command_timeout_s}s")
            continue
        if proc.returncode != 0:
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-8:]
            failures.append(f"`{cmd}` exited {proc.returncode}: " + " | ".join(tail))

    return VerifyResult(ok=not failures, failures=tuple(failures))
