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
from datetime import datetime
from pathlib import Path

from . import worktree as wt
from .config import Config
from .dispatcher import Dispatcher
from .events import EventLog
from .plan import PlanError, run_planner, write_drafts
from .task import Task, TicketError, load_backlog


class LoopError(Exception):
    """The loop could not start (dirty repo, bad branch); message is actionable."""


@dataclass(frozen=True)
class LoopSpec:
    objective: str
    # exit 0 == the objective is met (a read-only check). Optional: when empty the
    # loop has no acceptance gate and stops on work-exhaustion / budget / iterations
    # (the natural terminator for the backlog and self modes).
    accept_cmd: str = ""
    # Where each round's work comes from:
    #   "explicit" — plan the objective (+ acceptance output) into tickets;
    #   "backlog"  — drain an existing backlog (source_backlog), no planning spend;
    #   "self"     — auto-improve: split the repo's top oversized file each round.
    mode: str = "explicit"
    source_backlog: Path | None = None    # backlog mode: the ticket dir to drain
    name: str = "autopilot"
    budget_usd: float | None = None
    max_iterations: int = 5
    dry_cap: int = 2             # consecutive rounds that produce no work -> stop
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
    # No acceptance command -> no success gate; the loop terminates on
    # work-exhaustion, budget or max iterations instead.
    if not spec.accept_cmd.strip():
        return False, ""
    rc, out = _run(spec.accept_cmd, repo, spec.accept_timeout_s)
    return rc == 0, out.strip()[-2000:]


def _safe_runs_dir(repo: Path, runs_dir: Path) -> Path:
    """Keep the loop's writes OUT of the target repo's working tree. A runs dir
    inside the repo that git does NOT ignore would dirty the tree and fail the
    preflight every iteration — so relocate it beside the repo. A dir outside the
    repo, or one git ignores (e.g. the warden workspace's gitignored .factory/),
    is left as-is."""
    runs_dir = runs_dir.resolve()
    repo = repo.resolve()
    inside = runs_dir == repo or repo in runs_dir.parents
    if not inside:
        return runs_dir
    rel = runs_dir.relative_to(repo)
    ignored = wt.git(repo, "check-ignore", str(rel), check=False).returncode == 0
    if ignored:
        return runs_dir
    return repo.parent / ".warden-runs" / repo.name


def _read_objective(loop_dir: Path, fallback: str) -> str:
    """The loop's LIVE objective — re-read every round from objective.md so the
    operator can re-steer a running loop (edit the file / POST it from the UI)
    without restarting. Falls back to the objective it started with."""
    f = loop_dir / "objective.md"
    try:
        if f.exists():
            txt = f.read_text(encoding="utf-8").strip()
            if txt:
                return txt
    except OSError:
        pass
    return fallback


def _self_goal(repo: Path) -> str | None:
    """Self mode's work-picker: the top oversized file becomes a split objective.
    None when the repo has no oversized file left (the loop then stops, dry)."""
    from .hotspots import scan_hotspots
    spots = scan_hotspots(repo)
    if not spots:
        return None
    return (
        f"Split {spots[0].path} into smaller, cohesive modules — a pure mechanical "
        f"refactor: move code into new files and wire imports/exports, change no "
        f"behavior. Keep the build and tests green."
    )


async def _next_step(
    cfg: Config, repo: Path, mission: str, progress: str, log_path: Path
) -> str | None:
    """Supervisor mode's decomposer: given the mission and the work already landed
    on the integration branch, a read-only agent proposes the NEXT concrete
    objective — or declares the mission complete (returns None)."""
    from .agent import build_cli, extract_trailing_json, spawn_env, stream_headless
    from .plan import PLANNER_TOOLS
    contract = (
        "# Autopilot supervisor — decomposition\n\n"
        "You steer an autopilot loop toward a MISSION. Read the repo as needed, then "
        "propose the NEXT single, concrete, self-contained objective that moves the "
        "mission forward (one meaningful chunk, not everything at once), OR declare "
        "the mission complete if the progress already satisfies it.\n\n"
        f"## Mission\n{mission}\n\n"
        f"## Progress so far (commits on the work branch)\n{progress or '(nothing yet)'}\n\n"
        'End with a strict JSON block (no fences): {"status": "continue", "objective": '
        '"<the next concrete objective>"}  or  {"status": "done", "reason": "<why>"}.'
    )
    cmd = build_cli(cfg.agent.command, max_turns=40, allowed_tools=PLANNER_TOOLS,
                    model=cfg.plan.model or cfg.agent.model)
    try:
        out = await stream_headless(cmd, contract, repo, log_path, timeout_s=10 * 60,
                                    env=spawn_env(cfg.execution_mode))
    except TimeoutError:
        return None
    j = extract_trailing_json(str(out.result.get("result", ""))) if out.result else None
    if not j or j.get("status") != "continue":
        return None
    return str(j.get("objective", "")).strip() or None


async def _pick_work(
    spec: LoopSpec, cfg_i: Config, repo: Path, objective: str, out: str, base: str,
    integ: str, loop_dir: Path, loop_backlog: Path, i: int,
) -> list[Task]:
    """Where one round's work comes from, per mode. Returns ready-to-run tasks
    (empty = nothing to do this round -> the loop counts a dry round)."""
    if spec.mode == "backlog":
        # Drain an existing backlog — no planning spend. Empty/exhausted -> [].
        if not spec.source_backlog or not spec.source_backlog.is_dir():
            return []
        try:
            return load_backlog(spec.source_backlog, integ)
        except TicketError:
            return []

    # AUTO-RETRY: tickets still in the loop backlog were attempted last round and did
    # NOT merge (merged ones are archived to done/). Re-run THOSE first, before
    # planning anything new — so a failure is retried, never duplicated, and the ids
    # never restart. We only plan the next chunk once the backlog is drained.
    if loop_backlog.is_dir() and any(loop_backlog.glob("*.md")):
        try:
            return load_backlog(loop_backlog, integ)
        except TicketError:
            pass

    if spec.mode == "self":
        goal = _self_goal(repo)
        if goal is None:
            return []
    elif spec.mode == "supervisor":
        # The supervisor decomposes the mission into the next concrete objective,
        # given what has already landed on the integration branch.
        progress = wt.git(repo, "log", "--oneline", f"{base}..{integ}", check=False).stdout.strip()
        goal = await _next_step(cfg_i, repo, objective, progress, loop_dir / f"sup-{i}.jsonl")
        if goal is None:
            return []
    else:  # explicit: plan the objective plus the acceptance output (the gap)
        goal = objective + (f"\n\n## Current state — not yet met\n{out}" if out else "")

    try:
        contract = await run_planner(cfg_i, repo, goal, loop_dir / f"plan-{i}.jsonl")
    except PlanError:
        return []
    dicts = contract.get("tickets") or []
    if not dicts:
        return []
    write_drafts(dicts, loop_backlog, repo)
    return load_backlog(loop_backlog, integ)


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

    # Never let the loop's own writes dirty the target repo (a runs dir inside the
    # tree that git doesn't ignore fails the preflight every iteration).
    runs_dir = _safe_runs_dir(repo, runs_dir)

    base = cfg.base_branch
    integ = f"warden/loop-{spec.name}"
    loop_dir = runs_dir / f"loop-{spec.name}"
    loop_dir.mkdir(parents=True, exist_ok=True)
    loop_backlog = loop_dir / "backlog"
    log = EventLog(loop_dir / "loop.jsonl")

    # The live objective: seed objective.md once, then re-read it every round so the
    # operator can re-steer a running loop from the UI (POST /api/loop/steer) or by
    # editing the file — the volant live.
    obj_file = loop_dir / "objective.md"
    if spec.objective and not obj_file.exists():
        obj_file.write_text(spec.objective, encoding="utf-8")
    last_objective = spec.objective

    # Create (or reuse) the integration branch off the base and check it out. The
    # dispatcher runs with base = integ, so verified tickets land HERE, not on main.
    if wt.git(repo, "branch", "--list", integ, check=False).stdout.strip():
        wt.git(repo, "checkout", integ)
    else:
        wt.git(repo, "checkout", "-b", integ, base)
    base_before = wt.git(repo, "rev-parse", base, check=False).stdout.strip()

    log.emit(
        "loop_start", name=spec.name, mode=spec.mode, objective=spec.objective[:500],
        integ=integ, base=base, budget=spec.budget_usd, max_iterations=spec.max_iterations,
    )

    spent = 0.0
    per_ticket_costs: list[float] = []
    dry = 0
    fails = 0
    stop = "max_iterations"

    for i in range(1, spec.max_iterations + 1):
        # Re-steer: pick up any live edit to the objective before this round.
        objective = _read_objective(loop_dir, spec.objective)
        if objective != last_objective:
            last_objective = objective
            log.emit("steered", n=i, objective=objective[:500])

        ok, out = _acceptance(spec, repo)
        if ok:
            stop = "success"
            break
        if spec.budget_usd is not None and spent >= spec.budget_usd:
            stop = "budget"
            break

        # Pick this round's work (mode-specific). Empty -> a dry round.
        tasks = await _pick_work(
            spec, replace(cfg, base_branch=integ), repo, objective, out, base, integ,
            loop_dir, loop_backlog, i,
        )
        if not tasks:
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
            if spent + median * len(tasks) > spec.budget_usd:
                stop = "budget_forecast"
                break

        remaining = None if spec.budget_usd is None else max(spec.budget_usd - spent, 0.01)
        # Inside the loop, PR mode is OFF: tickets merge onto the integration
        # branch. Only the final integration -> base delivery is a PR.
        iter_cfg = replace(
            cfg, base_branch=integ,
            pr=replace(cfg.pr, enabled=False), budget_usd=remaining,
        )
        # Each iteration is a TOP-LEVEL run (timestamp-prefixed so it sorts
        # chronologically among normal runs, "-loop-<name>-" marks it autopilot):
        # the dashboard's tailer picks it up, so the loop's tickets appear and move
        # on the Kanban live instead of the loop being a black box.
        run_dir = runs_dir / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}-loop-{spec.name}-{i}"
        counts = await Dispatcher(iter_cfg, tasks, run_dir).run()

        costs = _run_costs(run_dir)
        spent += sum(costs)
        per_ticket_costs.extend(costs)
        merged = counts.get("DONE", 0)
        log.emit("loop_iter", n=i, mode=spec.mode, run=run_dir.name, planned=len(tasks),
                 merged=merged, spent=round(spent, 4))
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
