"""Autopilot loop (increment 1) — the guardrailed outer cycle.

Drives repeated plan -> run cycles toward an objective's ACCEPTANCE CRITERIA, on
a dedicated integration branch, under hard stops (budget, iterations, dry rounds,
consecutive failures). The base branch (e.g. main) is NEVER touched: tickets
auto-merge onto `warden/loop-<name>`, and the loop opens a SINGLE pull request
(integration branch -> base) at the end for the operator to test and merge.

Explicit-objective mode only for now (the objective + acceptance command are given
by the operator). Other command modes (backlog / supervisor / self) layer on top
of this same controller later.

The whole point of this increment is that the guardrails are PROVABLE without
spending a token: the e2e tests exercise every stop with the stub agent.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, replace
from pathlib import Path

from . import worktree as wt
from .config import Config
from .dispatcher import Dispatcher
from .events import EventLog
from .plan import PlanError, run_planner, write_drafts
from .task import load_backlog


class LoopError(Exception):
    """The loop could not start (dirty repo, bad branch); message is actionable."""


@dataclass(frozen=True)
class LoopSpec:
    objective: str
    accept_cmd: str              # exit 0 == the objective is met (a read-only check)
    name: str = "autopilot"
    budget_usd: float | None = None
    max_iterations: int = 5
    dry_cap: int = 2             # consecutive rounds that plan nothing new -> stop
    fail_cap: int = 2            # consecutive rounds where nothing merges -> stuck
    accept_timeout_s: int = 300


def _run(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(cwd), capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout_s,
        )
        return proc.returncode, (proc.stdout + proc.stderr)
    except subprocess.TimeoutExpired:
        return 124, f"acceptance command timed out after {timeout_s}s"


def _acceptance(spec: LoopSpec, repo: Path) -> tuple[bool, str]:
    rc, out = _run(spec.accept_cmd, repo, spec.accept_timeout_s)
    return rc == 0, out.strip()[-2000:]


def _run_costs(run_dir: Path) -> list[float]:
    """Per-agent costs recorded by one dispatcher run (from its events)."""
    events = run_dir / "events.jsonl"
    if not events.exists():
        return []
    return [
        float(e.get("cost_usd") or 0.0)
        for e in EventLog.replay(events)
        if e.get("event") == "agent_result" and (e.get("cost_usd") or 0) > 0
    ]


async def run_loop(cfg: Config, spec: LoopSpec, repo: Path, runs_dir: Path) -> dict:
    """Run the autopilot loop to a terminal stop and return a summary."""
    if not (repo / ".git").exists():
        raise LoopError(f"{repo} is not a git repository")
    if not wt.is_clean(repo):
        raise LoopError(f"{repo} has uncommitted changes — commit or stash them first")

    base = cfg.base_branch
    integ = f"warden/loop-{spec.name}"
    loop_dir = runs_dir / f"loop-{spec.name}"
    loop_dir.mkdir(parents=True, exist_ok=True)
    loop_backlog = loop_dir / "backlog"
    log = EventLog(loop_dir / "loop.jsonl")

    # Create (or reuse) the integration branch off the base and check it out. The
    # dispatcher runs with base = integ, so verified tickets land HERE, not on main.
    if wt.git(repo, "branch", "--list", integ, check=False).stdout.strip():
        wt.git(repo, "checkout", integ)
    else:
        wt.git(repo, "checkout", "-b", integ, base)
    base_before = wt.git(repo, "rev-parse", base, check=False).stdout.strip()

    log.emit(
        "loop_start", name=spec.name, objective=spec.objective[:500], integ=integ,
        base=base, budget=spec.budget_usd, max_iterations=spec.max_iterations,
    )

    spent = 0.0
    per_ticket_costs: list[float] = []
    dry = 0
    fails = 0
    stop = "max_iterations"

    for i in range(1, spec.max_iterations + 1):
        ok, out = _acceptance(spec, repo)
        if ok:
            stop = "success"
            break
        if spec.budget_usd is not None and spent >= spec.budget_usd:
            stop = "budget"
            break

        # Plan the GAP: the objective plus the acceptance check's current output,
        # so each round targets what is still failing rather than replanning blind.
        goal = spec.objective
        if out:
            goal += f"\n\n## Current state — acceptance not yet met\n{out}"
        try:
            contract = await run_planner(
                replace(cfg, base_branch=integ), repo, goal, loop_dir / f"plan-{i}.jsonl"
            )
            tickets = contract.get("tickets") or []
        except PlanError as exc:
            log.emit("loop_iter", n=i, planned=0, reason=str(exc)[:200])
            tickets = []
        if not tickets:
            dry += 1
            if dry >= spec.dry_cap:
                stop = "dry"
                break
            continue

        # Forecast-gate: once we have cost history, estimate this round BEFORE
        # spending and stop if it would cross the cap (the first round has no
        # history, so it always runs — you always get at least one iteration).
        if per_ticket_costs and spec.budget_usd is not None:
            ordered = sorted(per_ticket_costs)
            median = ordered[len(ordered) // 2]
            if spent + median * len(tickets) > spec.budget_usd:
                stop = "budget_forecast"
                break

        write_drafts(tickets, loop_backlog, repo)
        tasks = load_backlog(loop_backlog, integ)
        remaining = None if spec.budget_usd is None else max(spec.budget_usd - spent, 0.01)
        # Inside the loop, PR mode is OFF: tickets merge onto the integration
        # branch. Only the final integration -> base delivery is a PR.
        iter_cfg = replace(
            cfg, base_branch=integ,
            pr=replace(cfg.pr, enabled=False), budget_usd=remaining,
        )
        run_dir = loop_dir / f"iter-{i}"
        counts = await Dispatcher(iter_cfg, tasks, run_dir).run()

        costs = _run_costs(run_dir)
        spent += sum(costs)
        per_ticket_costs.extend(costs)
        merged = counts.get("DONE", 0)
        log.emit("loop_iter", n=i, planned=len(tasks), merged=merged, spent=round(spent, 4))
        if merged == 0:
            fails += 1
            if fails >= spec.fail_cap:
                stop = "stuck"
                break
        else:
            fails = 0
            dry = 0

    accepted, _ = _acceptance(spec, repo)

    # Deliver: open a SINGLE PR integ -> base for the operator to test + merge.
    # Base is never merged into here — the human owns that gate. No remote (local
    # repo) just means the branch is left for a manual merge.
    pr_url = ""
    if wt.remotes(repo):
        try:
            wt.push_branch(repo, integ)
            body = f"Opened by the Warden autopilot loop.\n\n## Objective\n{spec.objective[:4000]}"
            proc = subprocess.run(
                ["gh", "pr", "create", "--base", base, "--head", integ,
                 "--title", f"Autopilot: {spec.name}", "--body", body],
                cwd=str(repo), capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            if proc.returncode == 0 and proc.stdout.strip():
                pr_url = proc.stdout.strip().splitlines()[-1].strip()
        except Exception:  # noqa: BLE001 — delivery is best-effort; the branch survives
            pr_url = ""

    # Return the checkout to the base branch. It is unchanged: the loop's work
    # lives on the integration branch, waiting for the human's merge.
    wt.git(repo, "checkout", base, check=False)
    base_after = wt.git(repo, "rev-parse", base, check=False).stdout.strip()

    log.emit(
        "loop_end", stop=stop, spent=round(spent, 4), accepted=accepted,
        integ=integ, pr=pr_url, base_untouched=(base_before == base_after),
    )
    return {
        "stop": stop, "spent": spent, "accepted": accepted,
        "integ": integ, "pr": pr_url, "base_untouched": base_before == base_after,
    }
