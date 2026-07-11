"""Control plane: operator commands appended to control.jsonl by the dashboard."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from conftest import write_ticket
from factory.dispatcher import Dispatcher
from factory.events import EventLog
from factory.task import TaskState, load_backlog
from test_e2e import make_config, run_dispatcher


def make_dispatcher(tmp_path: Path, repo: Path, **ticket_meta) -> Dispatcher:
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, **ticket_meta)
    tasks = load_backlog(backlog, "main")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    return Dispatcher(make_config(), tasks, run_dir)


def control_write(run_dir: Path, op: str, task: str | None = None) -> None:
    with (run_dir / "control.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"op": op, "task": task}) + "\n")


def test_retry_requeues_failed_task_with_fresh_budget(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    task.attempts = 3
    d.state[task.id] = TaskState.FAILED
    control_write(d.run_dir, "retry", task.id)
    d._poll_control()
    assert d.state[task.id] is TaskState.QUEUED
    assert task.attempts == 0
    assert "manually retried" in task.failure_notes[-1]


def test_retry_ignores_running_task(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.RUNNING
    control_write(d.run_dir, "retry", "001")
    d._poll_control()
    assert d.state["001"] is TaskState.RUNNING


def test_pause_resume_and_stop_flags(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    control_write(d.run_dir, "pause")
    d._poll_control()
    assert d._manual_pause
    control_write(d.run_dir, "resume")
    d._poll_control()
    assert not d._manual_pause
    assert d._pause_until == 0.0  # resume also overrides a rate-limit pause
    control_write(d.run_dir, "stop")
    d._poll_control()
    assert d._stopped
    events = [e["event"] for e in EventLog.replay(d.run_dir / "events.jsonl")]
    assert events.count("control") == 3
    assert "paused_manual" in events and "resumed" in events and "stopped" in events


def test_commands_are_applied_exactly_once(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    control_write(d.run_dir, "pause")
    d._poll_control()
    d._manual_pause = False
    d._poll_control()  # same file, no new lines: must not re-apply
    assert not d._manual_pause


def test_kill_terminates_a_running_agent(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:SLEEP\n", max_retries=0)
    run_dir = tmp_path / "run"

    def issue_kill() -> None:
        deadline = time.monotonic() + 10
        events = run_dir / "events.jsonl"
        while time.monotonic() < deadline:  # wait until the agent is actually running
            if events.exists() and '"to": "RUNNING"' in events.read_text(encoding="utf-8"):
                control_write(run_dir, "kill", "001")
                return
            time.sleep(0.1)

    killer = threading.Thread(target=issue_kill)
    killer.start()
    counts = run_dispatcher(make_config(), backlog, run_dir)
    killer.join()

    assert counts == {"FAILED": 1}
    failures = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "failure"]
    assert "killed by the operator" in failures[0]["reason"]


def test_stop_drains_without_launching_queued(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:SLEEP\n", max_retries=0,
                 files_hint="[a.txt]")
    write_ticket(backlog, "002", repo, files_hint="[b.txt]", priority=9)
    run_dir = tmp_path / "run"

    def issue() -> None:
        deadline = time.monotonic() + 10
        events = run_dir / "events.jsonl"
        while time.monotonic() < deadline:
            if events.exists() and '"to": "RUNNING"' in events.read_text(encoding="utf-8"):
                control_write(run_dir, "stop")
                control_write(run_dir, "kill", "001")
                return
            time.sleep(0.1)

    cfg = make_config(max_slots=1)  # 002 stays queued behind the sleeper
    t = threading.Thread(target=issue)
    t.start()
    counts = run_dispatcher(cfg, backlog, run_dir)
    t.join()

    assert counts.get("FAILED") == 1  # the killed sleeper
    assert counts.get("QUEUED") == 1  # 002 left intact for a later run
