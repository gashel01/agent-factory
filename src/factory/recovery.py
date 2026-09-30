"""Recover from a run that died without shutting down (kill -9, power loss, a
closed terminal on Windows).

Such a run leaves three things behind: an events.jsonl without `run_end` (so
every reader shows it "in progress" forever), worktrees on disk, and
`agent/<run>/<task>` branches. Recovery, run under the run lock before a new run
starts:

- closes the dead run's log with a `run_end` marked `crashed`, so it reads as
  what it is;
- removes its worktrees;
- keeps every task branch that holds commits and hands it to the next run, which
  starts that ticket FROM the branch — an interrupted hour of agent work is
  continued, not redone. Empty branches are deleted.

Merged tickets were already archived out of the backlog when they merged, so the
next run naturally picks up exactly the unfinished work.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from . import worktree as wt_mod
from .events import EventLog


@dataclass
class RecoveryReport:
    runs: list[str] = field(default_factory=list)
    # (repo, task id) -> branch holding that task's interrupted commits
    adopt: dict[tuple[Path, str], str] = field(default_factory=dict)
    removed_worktrees: int = 0
    deleted_branches: int = 0


def unfinished_runs(runs_dir: Path) -> list[Path]:
    """Run directories whose log started but never ended."""
    if not runs_dir.is_dir():
        return []
    out: list[Path] = []
    for run_dir in sorted(p for p in runs_dir.iterdir() if p.is_dir()):
        log = run_dir / "events.jsonl"
        if not log.exists():
            continue
        started = ended = False
        for event in EventLog.replay(log):
            kind = event.get("event")
            started = started or kind == "run_start"
            ended = ended or kind == "run_end"
        if started and not ended:
            out.append(run_dir)
    return out


def _last_states(log: Path) -> dict[str, str]:
    states: dict[str, str] = {}
    for event in EventLog.replay(log):
        if event.get("event") == "state":
            states[str(event.get("task"))] = str(event.get("to"))
    return states


def _run_worktrees(repo: Path, run_dir: Path) -> list[Path]:
    listing = wt_mod.git(repo, "worktree", "list", "--porcelain", check=False).stdout
    root = (run_dir / "wt").resolve()
    paths: list[Path] = []
    for line in listing.splitlines():
        if not line.startswith("worktree "):
            continue
        path = Path(line.removeprefix("worktree ").strip())
        try:
            if root in path.resolve().parents:
                paths.append(path)
        except OSError:
            continue
    return paths


def recover(runs_dir: Path, bases: dict[Path, str]) -> RecoveryReport:
    """Close out every unfinished run under ``runs_dir``.

    ``bases`` maps each repository the next run touches to its base branch; only
    those repositories are cleaned (a run can't know about repos outside its
    backlog). Call ONLY while holding the run lock — a live run looks exactly
    like an unfinished one from its log alone.
    """
    report = RecoveryReport()
    for run_dir in unfinished_runs(runs_dir):
        run_id = run_dir.name
        report.runs.append(run_id)
        kept: list[str] = []
        for repo, base in bases.items():
            for path in _run_worktrees(repo, run_dir):
                wt_mod.remove(
                    wt_mod.Worktree(path=path, branch="", repo=repo), delete_branch=False
                )
                report.removed_worktrees += 1
            refs = wt_mod.git(
                repo, "for-each-ref", "--format=%(refname:short)",
                f"refs/heads/agent/{run_id}/", check=False,
            ).stdout.split()
            for branch in refs:
                task_id = branch.rsplit("/", 1)[-1]
                ahead = wt_mod.git(
                    repo, "rev-list", "--count", f"{base}..{branch}", check=False
                ).stdout.strip()
                if ahead.isdigit() and int(ahead) > 0:
                    # Several dead runs may have worked the same ticket: the most
                    # recent one (runs sort chronologically) wins.
                    report.adopt[(repo.resolve(), task_id)] = branch
                    kept.append(task_id)
                else:
                    wt_mod.git(repo, "branch", "-D", branch, check=False)
                    report.deleted_branches += 1
        log = EventLog(run_dir / "events.jsonl")
        states = _last_states(run_dir / "events.jsonl")
        log.emit("recovered", kept_branches=sorted(kept))
        log.emit("run_end", counts=dict(Counter(states.values())), stopped=True,
                 crashed=True)
    return report
