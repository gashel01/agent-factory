"""CLI entry point: factory run | status | report | clean."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .checkpoint import make_checkpoint
from .config import ConfigError, load_config
from .dispatcher import Dispatcher
from .doctor import DoctorError, format_report, run_doctor
from .events import EventLog
from .hotspots import DEFAULT_MIN_TOKENS, scan_hotspots
from .loop import LoopError, LoopSpec, run_loop
from .plan import (
    PlanError,
    read_brief,
    run_planner,
    run_questions,
    write_brief,
    write_drafts,
)
from .supervise import SuperviseError, ask, format_answer, reset
from .task import TicketError, load_backlog, parse_ticket
from .worktree import GitError, ensure_base_checked_out, prune


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
    # --base overrides the delivery target for THIS run only (no factory.yaml edit):
    # verified tickets merge onto <base> instead of the config's base_branch, so a
    # batch can be delivered to a fresh integration branch and land as one PR.
    cfg = load_config(args.config).with_overrides(
        max_slots=args.slots, base_branch=getattr(args, "base", None)
    )
    tasks = load_backlog(args.backlog, cfg.base_branch, cfg.default_max_retries)

    # A run only launches AI tickets that aren't on hold. Manual tickets belong to
    # a human developer; held tickets are paused by the operator. Both stay in the
    # backlog. Treat a dependency on a skipped ticket as satisfied (the dev/operator
    # handles it) so a run never dead-locks waiting on work it won't do.
    skipped_ids = {t.id for t in tasks if t.assignee == "human" or t.hold}
    tasks = [t for t in tasks if t.assignee == "ai" and not t.hold]
    for t in tasks:
        if skipped_ids & set(t.depends_on):
            t.depends_on = tuple(d for d in t.depends_on if d not in skipped_ids)
    if not tasks:
        print("no AI tickets to run (all are assigned to a human or on hold).")
        return 0

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

    # Deliver to the requested base: create the integration branch and check it out
    # (per repo in the batch) so the merge queue's preflight passes — the operator
    # never has to switch branches by hand. Guarded against a dirty tree upstream.
    if getattr(args, "base", None):
        for repo in {t.repo for t in tasks if t.repo}:
            ensure_base_checked_out(Path(repo), args.base)

    # Absolute, always: worktree paths are handed to `git -C <repo>`, which
    # resolves relative paths against the REPO, not our cwd.
    run_dir = (args.runs / datetime.now().strftime("%Y-%m-%d_%H%M%S")).resolve()
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
    workspace = Path.cwd()
    brief = read_brief(workspace, repo)
    if brief:
        print("reusing the saved project map (skips a full re-scan)")

    if getattr(args, "ask", False):
        # Clarify-first: explore the repo, then emit questions as a machine-readable
        # marker line for the dashboard. No drafts are written in this pass.
        print(f"exploring {repo} to work out what to ask … (read-only, ~1-3 min)")
        questions = asyncio.run(run_questions(cfg, repo, args.goal, log_path, brief))
        print("@plan-questions " + json.dumps({"questions": questions}))
        print(f"\n{len(questions)} clarifying question(s) — answer them, then draft.")
        return 0

    print(f"planning against {repo} … (one read-only agent, ~1-3 min)")
    contract = asyncio.run(run_planner(cfg, repo, args.goal, log_path, brief))
    # Persist the (refreshed) project map, keyed to THIS repo, so the next plan
    # and every coding agent reuse it — and a different repo never inherits it.
    write_brief(workspace, repo, str(contract.get("brief", "")))
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


def cmd_loop(args: argparse.Namespace) -> int:
    """Autopilot: plan->run toward an objective's acceptance criteria on a
    dedicated integration branch, under hard guardrails. Opt-in and bounded."""
    cfg = load_config(args.config)
    repo = args.repo.resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git repository", file=sys.stderr)
        return 2
    if args.mode in ("explicit", "supervisor") and not args.objective.strip():
        print(f"error: {args.mode} mode needs an objective", file=sys.stderr)
        return 2
    if args.mode == "backlog" and not args.source_backlog:
        print("error: backlog mode needs --source-backlog", file=sys.stderr)
        return 2
    spec = LoopSpec(
        objective=args.objective, accept_cmd=args.accept, mode=args.mode,
        source_backlog=args.source_backlog, name=args.name,
        budget_usd=args.budget, max_iterations=args.max_iterations,
        dry_cap=args.dry_cap, fail_cap=args.fail_cap,
    )
    print(f"autopilot '{spec.name}' → integration branch warden/loop-{spec.name} "
          f"(base {cfg.base_branch} stays untouched)")
    result = asyncio.run(run_loop(cfg, spec, repo, args.runs))
    print(
        f"\nstopped: {result['stop']}  (spent ${result['spent']:.2f}, "
        f"accepted={result['accepted']}, base untouched={result['base_untouched']})"
    )
    if result["pr"]:
        print(f"PR opened for you to test and merge: {result['pr']}")
    else:
        print(f"work is on {result['integ']} — test it, then merge into {cfg.base_branch}")
    return 0


def cmd_hotspots(args: argparse.Namespace) -> int:
    """Deterministic oversized-file scan: no agent, no tokens. Feeds the dashboard
    (``--json``) and gives the operator a straight answer at the terminal."""
    repo = args.repo.resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git repository", file=sys.stderr)
        return 2
    spots = scan_hotspots(repo, min_tokens=args.min_tokens, limit=args.limit)
    if args.json:
        print(json.dumps({
            "hotspots": [
                {
                    "path": h.path, "sizeBytes": h.size_bytes, "estTokens": h.est_tokens,
                    "edits": h.edits, "score": round(h.score, 1),
                }
                for h in spots
            ],
        }))
        return 0
    if not spots:
        print("No oversized source files — nothing worth splitting.")
        return 0
    print(f"{len(spots)} large file(s) — reading one in full can weigh on a ticket:")
    for h in spots:
        print(f"  {h.label()}")
    print("\nTip: splitting the top ones into modules keeps tickets that touch them cheaper.")
    return 0


def _activity_snippet(record: dict) -> str:
    """One short human line describing an assistant turn (its text, or the tool
    it is using), for live progress. Empty when there's nothing worth showing."""
    msg = record.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if not isinstance(content, list):
        return ""
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            text = " ".join(str(item.get("text", "")).split())
            if text:
                return text[:140]
        if item.get("type") == "tool_use":
            name = str(item.get("name", "")).replace("mcp__", "")
            inp = item.get("input") if isinstance(item.get("input"), dict) else {}
            hint = str(inp.get("file_path") or inp.get("pattern") or inp.get("path") or "")
            return f"{name} {hint}".strip()[:140]
    return ""


def cmd_ask(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    workdir = Path.cwd()
    if args.reset:
        reset(workdir)
        print("supervisor conversation reset")
        if not args.message:
            return 0
    if not args.message.strip():
        print("error: a message is required (or use --reset)", file=sys.stderr)
        return 2
    log_path = args.runs / "supervisor" / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.jsonl"

    on_activity = None
    if args.stream:
        # Progress goes to STDERR as JSON lines; STDOUT stays the clean final answer
        # (the dashboard JSON-parses stdout whole, so it must carry only the reply).
        def on_activity(record: dict) -> None:  # noqa: F811 — deliberate rebind
            snippet = _activity_snippet(record)
            if snippet:
                line = json.dumps({"kind": "progress", "text": snippet})
                print(line, file=sys.stderr, flush=True)

    answer = asyncio.run(ask(cfg, workdir, args.message, log_path, args.runs, on_activity))
    # --json feeds the dashboard companion (structured suggestions become one-click
    # buttons); the default prints prose for a human at the terminal.
    print(json.dumps(answer) if args.json else format_answer(answer))
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    log_path = args.runs / "doctor" / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.jsonl"
    print("probing agent capabilities (one tiny agent, ~30s)…")
    report = asyncio.run(run_doctor(cfg, Path.cwd(), log_path))
    text = format_report(report)
    print(text)
    return 1 if "DENIED" in text else 0


def cmd_sandbox_preflight(args: argparse.Namespace) -> int:
    # Machine-readable readiness for the dashboard's /api/docker poll.
    from . import sandbox
    print(json.dumps(sandbox.preflight()))
    return 0


def cmd_sandbox_build(args: argparse.Namespace) -> int:
    # Build the isolation images; streams docker output so the dashboard job panel
    # shows live progress. Non-zero on failure so the UI can surface it.
    from . import sandbox
    try:
        sandbox.build()
    except sandbox.SandboxError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    tasks = load_backlog(args.backlog, cfg.base_branch)
    for repo in {t.repo for t in tasks}:
        prune(repo)
        print(f"pruned worktrees: {repo}")
    return 0


def cmd_coord(args: argparse.Namespace) -> int:
    """Agent-facing: read or append to this run's coordination bus. The bus path is
    handed to each agent via $FACTORY_COORD_PATH, so a `factory coord` the agent
    spawns from its own Bash finds the right run. Best-effort by design."""
    from .coordination import CoordinationBus, whereis
    path = os.environ.get("FACTORY_COORD_PATH", "")
    if not path:
        print("no active coordination bus (FACTORY_COORD_PATH unset)", file=sys.stderr)
        return 1
    bus = CoordinationBus(Path(path))
    ticket = args.ticket or os.environ.get("FACTORY_TICKET_ID", "agent")
    if args.whereis:
        print(whereis(bus.events(), args.whereis))  # empty line = unknown
        return 0
    if args.decision:
        key, sep, value = args.decision.partition("=")
        if not sep:
            print("--decision needs KEY=VALUE", file=sys.stderr)
            return 1
        bus.decision(ticket, key.strip(), value.strip())
        return 0
    if args.note:
        bus.discovery(ticket, args.note.strip())
        return 0
    print("use --whereis NAME | --decision KEY=VALUE | --note TEXT", file=sys.stderr)
    return 1


def cmd_checkpoint(args: argparse.Namespace) -> int:
    """PostToolUse hook body: commit the current worktree as an undo checkpoint.

    Claude Code invokes this after each file-edit tool with the hook payload on
    stdin (``{"tool_name", "tool_input", …}``). We derive a short label from the
    tool and its target file, then commit the cwd. Always exits 0 and swallows
    every error — a checkpoint must never break the agent's turn.
    """
    label = ""
    try:
        raw = sys.stdin.read()
        if raw.strip():
            payload = json.loads(raw)
            tool = str(payload.get("tool_name", "")).strip()
            tool_input = payload.get("tool_input")
            target = ""
            if isinstance(tool_input, dict):
                target = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
            name = Path(target).name if target else ""
            label = " ".join(part for part in (tool, name) if part).strip()
    except Exception:  # noqa: BLE001 — a malformed payload just means a blank label
        label = ""
    # Never surface a bookkeeping failure to the agent's turn.
    with contextlib.suppress(Exception):
        make_checkpoint(Path.cwd(), label)
    return 0


def main(argv: list[str] | None = None) -> int:
    # Windows consoles may default to cp1252; our output is consumed by the
    # dashboard server (and humans) as UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

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
    p_run.add_argument("--base", default=None,
                       help="deliver onto this branch for THIS run (created + checked "
                            "out if missing); e.g. a fresh integration branch")
    p_run.add_argument("--dry-run", action="store_true",
                       help="parse tickets, show schedule and collisions, launch nothing")
    p_run.set_defaults(func=cmd_run)

    p_plan = sub.add_parser("plan", parents=[common],
                            help="co-create tickets: an agent explores the repo and drafts them")
    p_plan.add_argument("goal", help="what you want done, in one or two sentences")
    p_plan.add_argument("--ask", action="store_true",
                        help="first ask clarifying questions (emit them as JSON), don't draft yet")
    p_plan.add_argument("--repo", type=Path, default=Path("."),
                        help="target repository (default: current directory)")
    p_plan.set_defaults(func=cmd_plan)

    p_ask = sub.add_parser("ask", parents=[common],
                           help="talk to the supervisor agent about the current run")
    p_ask.add_argument("message", nargs="?", default="",
                       help="your question or instruction to the supervisor")
    p_ask.add_argument("--reset", action="store_true",
                       help="forget the previous supervisor conversation")
    p_ask.add_argument("--json", action="store_true",
                       help="print the raw answer (reply, actions, suggestions) as JSON")
    p_ask.add_argument("--stream", action="store_true",
                       help="emit per-turn progress as JSON lines on stderr (for the dashboard)")
    p_ask.set_defaults(func=cmd_ask)

    p_loop = sub.add_parser(
        "loop", parents=[common],
        help="autopilot: plan+run toward an objective on an integration branch (opt-in, bounded)",
    )
    p_loop.add_argument("objective", nargs="?", default="",
                        help="what the loop should achieve (explicit mode)")
    p_loop.add_argument("--mode", choices=("explicit", "backlog", "self", "supervisor"),
                        default="explicit",
                        help="work source: explicit / backlog / self (auto-split) / supervisor")
    p_loop.add_argument("--accept", default="",
                        help="acceptance command: exits 0 when done (read-only); optional")
    p_loop.add_argument("--source-backlog", type=Path, default=None,
                        help="backlog mode: the ticket directory to drain")
    p_loop.add_argument("--repo", type=Path, default=Path("."), help="target repository")
    p_loop.add_argument("--name", default="autopilot",
                        help="loop name (names the integration branch)")
    p_loop.add_argument("--budget", type=float, default=None,
                        help="hard USD cap for the whole loop")
    p_loop.add_argument("--max-iterations", type=int, default=5,
                        help="hard stop after N iterations")
    p_loop.add_argument("--dry-cap", type=int, default=2,
                        help="stop after N rounds planning nothing")
    p_loop.add_argument("--fail-cap", type=int, default=2,
                        help="stop after N rounds with no merge")
    p_loop.set_defaults(func=cmd_loop)

    p_hot = sub.add_parser(
        "hotspots", parents=[common],
        help="deterministic scan for oversized source files (no agent, no tokens)",
    )
    p_hot.add_argument("--repo", type=Path, default=Path("."),
                       help="target repository (default: current directory)")
    p_hot.add_argument("--min-tokens", type=int, default=DEFAULT_MIN_TOKENS,
                       help=f"flag files estimated >= this many tokens (def {DEFAULT_MIN_TOKENS})")
    p_hot.add_argument("--limit", type=int, default=10, help="max files to report")
    p_hot.add_argument("--json", action="store_true",
                       help="machine-readable output (for the dashboard)")
    p_hot.set_defaults(func=cmd_hotspots)

    p_doctor = sub.add_parser("doctor", parents=[common],
                              help="verify agent permissions (internet, commands) for real")
    p_doctor.set_defaults(func=cmd_doctor)

    p_status = sub.add_parser("status", parents=[common], help="show the latest run")
    p_status.set_defaults(func=cmd_status)

    p_report = sub.add_parser("report", parents=[common], help="write reports/summary.md")
    p_report.set_defaults(func=cmd_report)

    p_clean = sub.add_parser("clean", parents=[common], help="prune orphaned worktrees")
    p_clean.set_defaults(func=cmd_clean)

    # Agent-facing: share/query the run's coordination bus (Levels 2-3).
    p_coord = sub.add_parser("coord",
                             help="share or query this run's shared workspace (used by agents)")
    p_coord.add_argument("--ticket", default="", help="ticket id (defaults to $FACTORY_TICKET_ID)")
    p_coord.add_argument("--whereis", default="", metavar="NAME",
                         help="print where a symbol/decision lives (empty if unknown)")
    p_coord.add_argument("--decision", default="", metavar="KEY=VALUE",
                         help="record a cross-cutting decision for sibling agents")
    p_coord.add_argument("--note", default="", metavar="TEXT",
                         help="record a free-form discovery for sibling agents")
    p_coord.set_defaults(func=cmd_coord)

    # Not for humans: the PostToolUse hook Warden injects when agent.checkpoints is on.
    p_checkpoint = sub.add_parser("checkpoint",
                                  help="internal: commit the worktree as an undo checkpoint (hook)")
    p_checkpoint.set_defaults(func=cmd_checkpoint)

    p_sbx_pre = sub.add_parser("sandbox-preflight",
                               help="print Docker sandbox readiness as JSON (dashboard poll)")
    p_sbx_pre.set_defaults(func=cmd_sandbox_preflight)

    p_sbx_build = sub.add_parser("sandbox-build",
                                 help="build the Docker sandbox isolation images")
    p_sbx_build.set_defaults(func=cmd_sandbox_build)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (TicketError, ConfigError, GitError, PlanError, SuperviseError, DoctorError,
            LoopError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
