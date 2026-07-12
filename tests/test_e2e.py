"""End-to-end: dispatcher + stub agent + real git repos, zero tokens consumed."""

from __future__ import annotations

import asyncio
import sys
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


def test_two_tasks_merge_to_main(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    write_ticket(backlog, "002", repo, files_hint="[output_002.txt]")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"DONE": 2}
    tree = git(repo, "ls-tree", "--name-only", "main")
    assert "output_001.txt" in tree and "output_002.txt" in tree
    assert git(repo, "branch", "--list", "agent/*") == ""  # branches cleaned up
    events = [e["event"] for e in EventLog.replay(tmp_path / "run" / "events.jsonl")]
    assert events[0] == "run_start" and events[-1] == "run_end"
    assert "merged" in events
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


def test_blocked_agent_surfaces_its_question(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:BLOCKED\n")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    assert counts == {"BLOCKED": 1}
    blocked = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
               if e["event"] == "blocked"]
    assert "database" in blocked[0]["question"]


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
