"""Verification gate: a task's work only exists once it is proven.

Three layers, all deterministic:
1. the branch must contain real committed changes (an agent that "succeeds"
   without a diff is lying);
2. the diff must leave the judging machinery alone — test-runner config, shared
   fixtures, CI, existing test files — unless the ticket owns those files
   (an agent that edits the judge can make a red suite read green);
3. every success-criteria command must exit 0 inside the worktree, and there
   must BE one unless the operator explicitly opted out.
"""

from __future__ import annotations

import fnmatch
import re
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


# Test files by the usual conventions (pytest, unittest, jest/vitest/mocha, go).
_TEST_FILE = re.compile(
    r"(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]*\.py$|_test\.(py|go)$"
    r"|\.(test|spec)\.[cm]?[jt]sx?$"
)


def _matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern) or (
        pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:])
    )


def _owned_by_ticket(path: str, task: Task) -> bool:
    """True when the ticket's files_hint covers this path (same prefix rule as the
    scheduler's collision check): a ticket that is ABOUT the test config may
    change it."""
    norm = path.lower().strip("/") + "/"
    for hint in task.files_hint:
        h = hint.replace("\\", "/").strip("/").lower() + "/"
        if norm.startswith(h) or h.startswith(norm):
            return True
    return False


def tamper_findings(task: Task, worktree_path: Path, protected: tuple[str, ...]) -> list[str]:
    """Changes to the judging machinery the ticket doesn't own.

    Two signals: a protected file (runner config, fixtures, CI) modified or
    removed, and an existing test file deleted. Editing or adding tests is
    normal work and is left to the reviewer, who judges intent.
    """
    if not protected:
        return []
    out = git(
        worktree_path, "diff", "--name-status", "--no-renames", f"{task.base_branch}...HEAD",
        check=False,
    ).stdout
    findings: list[str] = []
    for line in out.splitlines():
        status, _, path = line.partition("	")
        path = path.replace("\\", "/").strip()
        if not path or _owned_by_ticket(path, task):
            continue
        if any(_matches(path, pat) for pat in protected):
            findings.append(f"changed protected file `{path}` (not in the ticket's files_hint)")
        elif status.startswith("D") and _TEST_FILE.search(path):
            findings.append(f"deleted test file `{path}` (not in the ticket's files_hint)")
    return findings


def run_verify(
    task: Task, worktree_path: Path, cfg: VerifyConfig, runner: CommandRunner | None = None
) -> VerifyResult:
    commits = git(worktree_path, "rev-list", "--count", f"{task.base_branch}..HEAD")
    if int(commits.stdout.strip() or 0) == 0:
        return VerifyResult(ok=False, failures=("no commits on the task branch",))
    # Three-dot: did THIS branch add anything since it forked? Two-dot would call a
    # net-zero branch "changed" merely because the base advanced under it.
    diff = git(worktree_path, "diff", "--quiet", f"{task.base_branch}...HEAD", check=False)
    if diff.returncode == 0:
        return VerifyResult(ok=False, failures=("commits present but the diff is empty",))

    tampered = tamper_findings(task, worktree_path, cfg.protected)
    if tampered:
        return VerifyResult(ok=False, failures=tuple(tampered))

    commands = task.verify_commands or cfg.commands
    if not commands and cfg.require_commands:
        return VerifyResult(ok=False, failures=(
            "no success-criteria command to prove this works — add `verify:` to the "
            "ticket (or verify.commands in factory.yaml); for a change nothing can "
            "check automatically, set `skip_verify: true` on the ticket",
        ))
    # The git checks above stay on the host (fast, deterministic reads); only the
    # success-criteria commands — which execute the agent's own code — run in the
    # box when a runner is injected.
    failures = _run_commands(worktree_path, commands, cfg.command_timeout_s, runner)
    return VerifyResult(ok=not failures, failures=tuple(failures))


def run_integration(
    repo: Path, cfg: IntegrationConfig, runner: CommandRunner | None = None,
    cwd: Path | None = None,
) -> VerifyResult:
    """Run the integration suite once on the base branch, after all merges have
    landed. Proves the merged tickets hold together, not just each in isolation.

    By default it runs at the repo root; sandbox mode passes a scratch checkout
    of the base (``cwd``) and a box runner, since this is merged agent code too.
    """
    failures = _run_commands(cwd or repo, cfg.commands, cfg.command_timeout_s, runner)
    return VerifyResult(ok=not failures, failures=tuple(failures))
