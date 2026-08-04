"""End-to-end: dispatcher + stub agent + real git repos, zero tokens consumed."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest

from conftest import git, write_ticket
from factory.config import AgentConfig, Config, RateLimitConfig
from factory.dispatcher import Dispatcher
from factory.events import EventLog
from factory.task import load_backlog

STUB = Path(__file__).parent / "stub_agent.py"


def make_config(**kwargs) -> Config:
    defaults = dict(
        max_slots=2,
        stagger_seconds=0.0,
        agent=AgentConfig(command=(sys.executable, str(STUB))),
        ratelimit=RateLimitConfig(cooldown_min=0, max_pauses_before_stop=1),
    )
    defaults.update(kwargs)
    return Config(**defaults)


def run_dispatcher(cfg: Config, backlog: Path, run_dir: Path) -> dict[str, int]:
    tasks = load_backlog(backlog, cfg.base_branch)
    run_dir.mkdir(parents=True)
    return asyncio.run(Dispatcher(cfg, tasks, run_dir).run())


def test_run_syncs_base_from_remote_when_behind(tmp_path, repo):
    # The run works in a clone that is one commit behind its origin; the dispatcher
    # fetches and fast-forwards the base before spawning agents.
    import subprocess

    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(repo), str(clone)], check=True)
    git(clone, "config", "user.email", "t@t.co")
    git(clone, "config", "user.name", "t")
    (repo / "remote.txt").write_text("r", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "remote work")

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", clone, files_hint="[output_001.txt]")
    run_dir = tmp_path / "run"
    counts = run_dispatcher(make_config(), backlog, run_dir)

    assert counts == {"DONE": 1}
    sync = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "sync"]
    assert sync and sync[0]["behind"] == 1 and sync[0]["pulled"] is True
    # the pulled remote commit is now in the clone's base
    assert "remote.txt" in git(clone, "ls-tree", "--name-only", "main")


def test_pr_mode_fails_clearly_without_a_remote(tmp_path, repo):
    from factory.config import PrConfig

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]", max_retries=0)
    run_dir = tmp_path / "run"
    counts = run_dispatcher(make_config(pr=PrConfig(enabled=True)), backlog, run_dir)

    # No GitHub remote (or no gh): PR mode must fail with an actionable reason,
    # never merge locally, never crash the run.
    assert counts.get("FAILED") == 1
    fails = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "failure"]
    assert any("gh" in f["reason"] or "remote" in f["reason"] for f in fails)


def test_integration_check_runs_on_the_merged_repo(tmp_path, repo):
    # After the ticket merges, the integration suite runs ONCE at the repo root
    # (the base branch, with everything landed) and reports pass/fail.
    from factory.config import IntegrationConfig
    from factory.task import load_backlog

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    # A check that only passes if the merge actually landed the ticket's file.
    # Python, not `test -f`: the command runs through the platform shell, and
    # cmd.exe has no `test` builtin — this must pass from any shell.
    probe = "import os,sys; sys.exit(0 if os.path.exists('output_001.txt') else 1)"
    check = f'"{sys.executable}" -c "{probe}"'
    cfg = make_config(integration=IntegrationConfig(commands=(check,)))
    tasks = load_backlog(backlog, cfg.base_branch)
    counts = asyncio.run(Dispatcher(cfg, tasks, run_dir).run())

    assert counts == {"DONE": 1}
    events = list(EventLog.replay(run_dir / "events.jsonl"))
    integ = [e for e in events if e["event"] == "integration"]
    assert len(integ) == 1
    assert integ[0]["ok"] is True and integ[0]["repo"] == str(repo)
    # ordering: the check runs after the merge, before run_end
    kinds = [e["event"] for e in events]
    assert kinds.index("merged") < kinds.index("integration") < kinds.index("run_end")


def test_integration_check_reports_failure(tmp_path, repo):
    from factory.config import IntegrationConfig
    from factory.task import load_backlog

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    cfg = make_config(integration=IntegrationConfig(commands=("exit 1",)))
    tasks = load_backlog(backlog, cfg.base_branch)
    asyncio.run(Dispatcher(cfg, tasks, run_dir).run())

    integ = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "integration"]
    assert len(integ) == 1 and integ[0]["ok"] is False and integ[0]["failures"]


def test_control_mode_parks_then_merges_on_approve(tmp_path, repo):
    # Control mode on: the finished task must wait in AWAITING_APPROVAL until the
    # operator approves, then merge normally — nothing merges on its own.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    run_dir = tmp_path / "run"

    def approve_when_parked() -> None:
        deadline = time.monotonic() + 15
        events = run_dir / "events.jsonl"
        while time.monotonic() < deadline:
            if events.exists() and "awaiting_approval" in events.read_text(encoding="utf-8"):
                with (run_dir / "control.jsonl").open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"op": "approve", "task": "001"}) + "\n")
                return
            time.sleep(0.1)

    t = threading.Thread(target=approve_when_parked)
    t.start()
    counts = run_dispatcher(make_config(manual_approval=True), backlog, run_dir)
    t.join()

    assert counts == {"DONE": 1}
    events = [e["event"] for e in EventLog.replay(run_dir / "events.jsonl")]
    assert "awaiting_approval" in events  # it really parked
    assert events.index("awaiting_approval") < events.index("approved") < events.index("merged")
    assert "output_001.txt" in git(repo, "ls-tree", "--name-only", "main")


def test_two_tasks_merge_to_main(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    write_ticket(backlog, "002", repo, files_hint="[output_002.txt]")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"DONE": 2}
    tree = git(repo, "ls-tree", "--name-only", "main")
    assert "output_001.txt" in tree and "output_002.txt" in tree
    assert git(repo, "branch", "--list", "agent/*") == ""  # branches cleaned up
    all_events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    events = [e["event"] for e in all_events]
    assert events[0] == "run_start" and events[-1] == "run_end"
    assert "merged" in events
    # each merge records the SHA range of the ticket's changes so the dashboard
    # can show its diff after the branch is gone; the range is non-empty and real.
    for m in (e for e in all_events if e["event"] == "merged"):
        assert m["base"] and m["commit"] and m["base"] != m["commit"]
        assert m["repo"]
        diff = git(repo, "diff", f"{m['base']}..{m['commit']}", "--stat")
        assert diff.strip()  # the ticket actually changed files
    # merged tickets are archived so a second run cannot replay them
    assert list(backlog.glob("*.md")) == []
    assert len(list((backlog / "done").glob("*.md"))) == 2


def test_agent_without_commit_fails_after_retries(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:NO_COMMIT\n", max_retries=1)

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"FAILED": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    retries = [e for e in events if e["event"] == "retry"]
    assert len(retries) == 1  # one retry consumed, evidence recorded
    assert "no commits" in retries[0]["reason"]


def test_explicit_noop_is_done_not_failed(tmp_path, repo):
    # A ticket whose change already exists: the agent declares an explicit no-op
    # (done + "noop": true) and commits nothing. This must land as DONE (not fail on
    # "no commits") and archive the ticket — no destructive workaround to fabricate a
    # commit. A plain done-without-commit stays a failure (see the test above).
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:NOOP\n", max_retries=1)

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"DONE": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    assert any(e["event"] == "noop" and e["task"] == "001" for e in events)
    assert not [e for e in events if e["event"] == "retry"]  # no wasted retries
    assert list(backlog.glob("*.md")) == []  # archived to done/
    assert len(list((backlog / "done").glob("*.md"))) == 1


def test_retry_resumes_the_failed_session_in_the_same_worktree(tmp_path, repo):
    # Token saver: a retryable failure parks the worktree and the next attempt
    # RESUMES the agent's session (--resume <id>) with a short corrective prompt
    # instead of restarting cold. The stub proves both: it only commits the fix
    # when launched with --resume, and it records the session id it resumed.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:RESUME_FIX\n", max_retries=1)

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"DONE": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    retries = [e for e in events if e["event"] == "retry"]
    assert len(retries) == 1 and "no commits" in retries[0]["reason"]
    content = git(repo, "show", "main:fixed_by_resume.txt")
    assert "resumed session stub-agent-session-001" in content


def test_review_fails_open_after_persistent_rate_limit(tmp_path, repo):
    # A rate-limited reviewer must not re-review one ticket forever: after two
    # waits the gate fails open (the deterministic verify gate already passed)
    # and says so loudly in the review event.
    from factory.config import ReviewConfig

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:REVIEW_RATELIMIT\n")
    cfg = make_config(
        review=ReviewConfig(enabled=True),
        ratelimit=RateLimitConfig(cooldown_min=0, max_pauses_before_stop=10),
    )

    counts = run_dispatcher(cfg, backlog, tmp_path / "run")

    assert counts == {"DONE": 1}
    reviews = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
               if e["event"] == "review"]
    assert reviews[-1]["verdict"] == "approve"
    assert "fail-open" in reviews[-1]["reasons"][0]


def test_mixed_base_branches_in_one_repo_are_rejected_upfront(tmp_path, repo):
    # Two tickets on the same repo but different base branches would pass preflight
    # (first task's base) then fail at merge with an opaque error — reject it before
    # the run starts, with the actual conflict named.
    from factory.task import TicketError, load_backlog

    git(repo, "branch", "develop")
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[a.txt]")
    write_ticket(backlog, "002", repo, files_hint="[b.txt]", base_branch="develop")
    tasks = load_backlog(backlog, "main")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    with pytest.raises(TicketError, match="different base branches"):
        asyncio.run(Dispatcher(make_config(), tasks, run_dir).run())


def test_blocked_agent_surfaces_its_question(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:BLOCKED\n")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"BLOCKED": 1}
    blocked = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
               if e["event"] == "blocked"]
    assert "database" in blocked[0]["question"]


def test_agent_progress_streams_live(tmp_path, repo):
    # While an agent works, the dispatcher emits agent_progress events with a
    # growing turn/token count (C6), before the final agent_result.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")

    run_dir = tmp_path / "run"
    run_dispatcher(make_config(), backlog, run_dir)

    events = list(EventLog.replay(run_dir / "events.jsonl"))
    prog = [e for e in events if e["event"] == "agent_progress"]
    assert len(prog) >= 2
    assert [p["turns"] for p in prog] == sorted(p["turns"] for p in prog)  # monotonic
    assert prog[-1]["tokens"] > prog[0]["tokens"]  # tokens accumulate
    # progress precedes the terminal result for that agent
    kinds = [e["event"] for e in events]
    assert kinds.index("agent_progress") < kinds.index("agent_result")


def test_plan_limit_is_surfaced(tmp_path, repo):
    # The CLI streams a plan-window snapshot (reset time + status); the dispatcher
    # relays it as a plan_limit event so the dashboard can show plan usage.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")

    run_dir = tmp_path / "run"
    run_dispatcher(make_config(), backlog, run_dir)

    limits = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "plan_limit"]
    assert limits
    assert limits[0]["window"] == "five_hour"
    assert limits[0]["resets_at"] > 0  # a real epoch, relayed intact
    assert limits[0]["status"] == "allowed"


def test_webhook_notifications_fire(tmp_path, repo):
    # A blocked ticket must ping the webhook immediately (needs-you), and the run
    # must ping again with a summary when it ends. Both delivered server-side.
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from factory.config import NotifyConfig

    received: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            received.append(json.loads(self.rfile.read(length))["text"])
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    # Threaded so two webhook POSTs firing back-to-back at end-of-run never
    # starve each other's accept — a single-threaded server drops the second
    # under Windows socket timing, making this test flaky on CI.
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:BLOCKED\n")
    cfg = make_config(notify=NotifyConfig(webhook_url=f"http://{host}:{port}/hook"))

    def delivered() -> bool:
        return (
            any("blocked and needs you" in m for m in received)
            and any(m.startswith("[Agent Factory] Run") and "1 blocked" in m for m in received)
        )

    try:
        run_dispatcher(cfg, backlog, tmp_path / "run")
        # POSTs are best-effort; give the last one a beat to land before teardown.
        deadline = time.monotonic() + 5
        while not delivered() and time.monotonic() < deadline:
            time.sleep(0.05)
    finally:
        server.shutdown()
        server.server_close()

    assert any("blocked and needs you" in m for m in received)
    assert any(m.startswith("[Agent Factory] Run") and "1 blocked" in m for m in received)
    # the dispatcher records that it pinged
    notified = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
                if e["event"] == "notified"]
    assert notified and all(e["ok"] for e in notified)


def test_dependency_ordering_and_failure_propagation(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:NO_COMMIT\n", max_retries=0,
                 files_hint="[a.txt]")
    write_ticket(backlog, "002", repo, depends_on='["001"]', files_hint="[b.txt]")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"FAILED": 2}
    failures = {e["task"]: e["reason"] for e in
                EventLog.replay(tmp_path / "run" / "events.jsonl") if e["event"] == "failure"}
    assert "dependency failed" in failures["002"]


def test_rate_limit_pauses_then_stops_cleanly(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:RATELIMIT\n")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    # max_pauses_before_stop=1: first pause is consumed, second hit stops the run;
    # the task is left QUEUED (intact for a later run), never counted as a failure.
    assert counts == {"QUEUED": 1}
    events = [e["event"] for e in EventLog.replay(tmp_path / "run" / "events.jsonl")]
    assert "paused_ratelimit" in events
    assert "stopped" in events
    assert "skipped" in events


def test_dry_run_never_spawns(tmp_path, repo, capsys):
    from factory.__main__ import main

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    code = main(["run", "--backlog", str(backlog), "--dry-run",
                 "--runs", str(tmp_path / "runs")])
    assert code == 0
    out = capsys.readouterr().out
    assert "1 ticket(s) parsed" in out
    assert not (tmp_path / "runs").exists()


@pytest.mark.parametrize("slots", [1, 4])
def test_max_slots_is_a_user_parameter(tmp_path, repo, slots):
    backlog = tmp_path / "backlog"
    for i in range(3):
        write_ticket(backlog, f"00{i}", repo, files_hint=f"[output_00{i}.txt]")
    counts = run_dispatcher(make_config(max_slots=slots), backlog, tmp_path / "run")
    assert counts == {"DONE": 3}


def test_interrupted_run_leaves_no_ghost(tmp_path, repo):
    """A cancelled/crashed dispatcher must still write a terminal state for every
    task and a run_end — otherwise the dashboard shows a task "still working"
    forever and its stop/kill commands reach a process that no longer exists.
    Regression for the orphaned-agent ghost seen live on 2026-07-12.
    """
    from factory.task import IN_FLIGHT

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:SLEEP")  # agent hangs 60s
    tasks = load_backlog(backlog, "main")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    dispatcher = Dispatcher(make_config(), tasks, run_dir)

    async def drive() -> dict[str, int]:
        run_task = asyncio.create_task(dispatcher.run())
        for _ in range(200):  # wait until the agent is actually RUNNING
            if dispatcher.state["001"].name == "RUNNING":
                break
            await asyncio.sleep(0.05)
        run_task.cancel()  # simulate the dispatcher process going away
        return await run_task

    asyncio.run(drive())

    # No task may be left in-flight, and the run must be sealed with run_end.
    assert all(state not in IN_FLIGHT for state in dispatcher.state.values())
    assert dispatcher.state["001"].name == "FAILED"
    events = [e["event"] for e in EventLog.replay(run_dir / "events.jsonl")]
    assert events[-1] == "run_end"


def test_budget_stops_the_run(tmp_path, repo):
    """A cost ceiling halts new launches once cumulative spend crosses it; the
    unspent tickets stay QUEUED for a later run. Each stub agent 'costs' $1."""
    backlog = tmp_path / "backlog"
    for i in range(3):
        write_ticket(backlog, f"00{i}", repo, files_hint=f"[output_00{i}.txt]")
    # slots=1 → strictly sequential, so the budget bites deterministically.
    cfg = make_config(max_slots=1, budget_usd=1.5)
    counts = run_dispatcher(cfg, backlog, tmp_path / "run")

    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    kinds = [e["event"] for e in events]
    assert "budget_exceeded" in kinds
    # Two agents ran (spend 1.0 then 2.0 ≥ 1.5); the third never launched.
    assert counts.get("DONE", 0) == 2
    assert counts.get("QUEUED", 0) == 1
    # Per-agent cost is recorded on the result events.
    results = [e for e in events if e["event"] == "agent_result"]
    assert all(r["cost_usd"] == 1.0 for r in results)
    assert results[-1]["spent_usd"] == 2.0
