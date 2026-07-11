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
