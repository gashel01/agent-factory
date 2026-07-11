"""CLI entry point: factory run | status | report | clean."""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .config import ConfigError, load_config
from .dispatcher import Dispatcher
from .events import EventLog
from .plan import PlanError, run_planner, write_drafts
from .task import TicketError, load_backlog, parse_ticket
from .worktree import GitError, prune


def _latest_run(runs_dir: Path) -> Path | None:
    candidates = sorted(p for p in runs_dir.glob("*") if (p / "events.jsonl").exists())
    return candidates[-1] if candidates else None


def _replay_states(run_dir: Path) -> tuple[dict[str, str], dict]:
    states: dict[str, str] = {}
    meta: dict = {}
    for event in EventLog.replay(run_dir / "events.jsonl"):
        if event["event"] == "state":
            states[event["task"]] = event["to"]
        elif event["event"] == "run_start":
            meta["start"] = event["ts"]
            meta["slots"] = event.get("slots")
        elif event["event"] == "run_end":
            meta["end"] = event["ts"]
            meta["counts"] = event.get("counts")
            meta["stopped"] = event.get("stopped")
        elif event["event"] in ("failure", "blocked"):
            meta.setdefault("issues", []).append(
                f"{event['task']}: {event.get('reason') or event.get('question', '')}"
            )
    return states, meta


def cmd_run(args: argparse.Namespace) -> int:
    cfg = load_config(args.config).with_overrides(max_slots=args.slots)
    tasks = load_backlog(args.backlog, cfg.base_branch)

    if args.dry_run:
        print(f"{len(tasks)} ticket(s) parsed, slots={cfg.max_slots}")
        for t in sorted(tasks, key=lambda t: (t.priority, t.id)):
            deps = f" deps={list(t.depends_on)}" if t.depends_on else ""
            hints = (f" hints={list(t.files_hint)}" if t.files_hint
                     else " hints=NONE (collides with everything in its repo)")
            print(f"  [{t.priority}] {t.id}: {t.title}{deps}{hints}")
        collisions = [
            (a.id, b.id)
            for i, a in enumerate(tasks)
            for b in tasks[i + 1 :]
            if a.collides_with(b)
        ]
        if collisions:
            print("serialized pairs (files_hint overlap):")
            for a, b in collisions:
                print(f"  {a} <-> {b}")
        return 0

    run_dir = args.runs / datetime.now().strftime("%Y-%m-%d_%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=False)
    print(f"run: {run_dir}")
    counts = asyncio.run(Dispatcher(cfg, tasks, run_dir).run())
    print("done:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 0 if counts.get("FAILED", 0) == 0 and counts.get("BLOCKED", 0) == 0 else 1


def cmd_status(args: argparse.Namespace) -> int:
    run_dir = _latest_run(args.runs)
    if run_dir is None:
        print(f"no runs found under {args.runs}")
        return 1
    states, meta = _replay_states(run_dir)
    print(f"run: {run_dir.name}  slots={meta.get('slots', '?')}"
          + (" [finished]" if "end" in meta else " [in progress]"))
    for task_id in sorted(states):
        print(f"  {task_id:<12} {states[task_id]}")
    for issue in meta.get("issues", []):
        print(f"  ! {issue}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    run_dir = _latest_run(args.runs)
    if run_dir is None:
        print(f"no runs found under {args.runs}")
        return 1
    states, meta = _replay_states(run_dir)
    lines = [
        f"# Run report — {run_dir.name}",
        "",
        f"- started: {meta.get('start', '?')}  finished: {meta.get('end', 'in progress')}",
        f"- slots: {meta.get('slots', '?')}  stopped on rate limit: {meta.get('stopped', False)}",
        "",
        "| task | final state |",
        "|------|-------------|",
        *(f"| {tid} | {state} |" for tid, state in sorted(states.items())),
    ]
    if meta.get("issues"):
        lines += ["", "## Issues", *(f"- {i}" for i in meta["issues"])]
    out = run_dir / "reports" / "summary.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out)
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    repo = args.repo.resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git repository", file=sys.stderr)
        return 2
    log_path = args.runs / "planner" / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.jsonl"
    print(f"planning against {repo} … (one read-only agent, ~1-3 min)")
    contract = asyncio.run(run_planner(cfg, repo, args.goal, log_path))
    written = write_drafts(contract["tickets"], args.backlog, repo)
    print(f"\n{len(written)} draft ticket(s) written to {args.backlog}:")
    for path in written:
        task = parse_ticket(path, cfg.base_branch)
        deps = f"  deps={list(task.depends_on)}" if task.depends_on else ""
        print(f"  {task.id}  {task.title}{deps}")
        print(f"       verify: {'; '.join(task.verify_commands) or '(none — add one!)'}")
    # ASCII only: Windows consoles may still run a cp1252 codepage.
    print("\nReview/edit them, then:  factory run --dry-run  ->  factory run")
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    tasks = load_backlog(args.backlog, cfg.base_branch)
    for repo in {t.repo for t in tasks}:
        prune(repo)
        print(f"pruned worktrees: {repo}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="factory", description=__doc__)
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--backlog", type=Path, default=Path("backlog"))
    common.add_argument("--config", type=Path, default=Path("factory.yaml"))
    common.add_argument("--runs", type=Path, default=Path("runs"))

    p_run = sub.add_parser("run", parents=[common], help="execute the backlog")
    p_run.add_argument("--slots", type=int, default=None,
                       help="max parallel agents (overrides factory.yaml; no hard ceiling)")
    p_run.add_argument("--dry-run", action="store_true",
                       help="parse tickets, show schedule and collisions, launch nothing")
    p_run.set_defaults(func=cmd_run)

    p_plan = sub.add_parser("plan", parents=[common],
                            help="co-create tickets: an agent explores the repo and drafts them")
    p_plan.add_argument("goal", help="what you want done, in one or two sentences")
    p_plan.add_argument("--repo", type=Path, default=Path("."),
                        help="target repository (default: current directory)")
    p_plan.set_defaults(func=cmd_plan)

    p_status = sub.add_parser("status", parents=[common], help="show the latest run")
    p_status.set_defaults(func=cmd_status)

    p_report = sub.add_parser("report", parents=[common], help="write reports/summary.md")
    p_report.set_defaults(func=cmd_report)

    p_clean = sub.add_parser("clean", parents=[common], help="prune orphaned worktrees")
    p_clean.set_defaults(func=cmd_clean)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (TicketError, ConfigError, GitError, PlanError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
