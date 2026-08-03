"""Control plane: operator commands appended to control.jsonl by the dashboard."""

from __future__ import annotations

import asyncio
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


def control_write(run_dir: Path, op: str, task: str | None = None, text: str | None = None) -> None:
    payload: dict = {"op": op, "task": task}
    if text is not None:
        payload["text"] = text
    with (run_dir / "control.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload) + "\n")


def test_dispatcher_loads_the_project_brief(tmp_path, repo):
    from factory.plan import write_brief
    ws = tmp_path / "ws"
    run_dir = ws / "runs" / "r1"
    run_dir.mkdir(parents=True)
    write_brief(ws, repo, "The shared project map.")  # keyed to this task's repo
    backlog = ws / "backlog"
    write_ticket(backlog, "001", repo)
    tasks = load_backlog(backlog, "main")
    d = Dispatcher(make_config(), tasks, run_dir)
    assert "shared project map" in d._brief_for(repo)


def test_retry_requeues_failed_task_with_fresh_budget(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    task.attempts = 3
    d.state[task.id] = TaskState.FAILED
    control_write(d.run_dir, "retry", task.id)
    asyncio.run(d._poll_control())
    assert d.state[task.id] is TaskState.QUEUED
    assert task.attempts == 0
    assert "manually retried" in task.failure_notes[-1]


def test_answer_requeues_blocked_task_with_question_and_reply(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    task.attempts = 2
    d.state[task.id] = TaskState.BLOCKED
    d._blocked_questions[task.id] = "Which auth provider should I wire up?"
    control_write(d.run_dir, "answer", task.id, text="Use Auth0, config is in .env")
    asyncio.run(d._poll_control())
    assert d.state[task.id] is TaskState.QUEUED
    assert task.attempts == 0
    note = task.failure_notes[-1]
    assert "Which auth provider" in note and "Use Auth0" in note
    # The question is consumed so a later answer doesn't re-pair with a stale one.
    assert task.id not in d._blocked_questions
    events = [e["event"] for e in EventLog.replay(d.run_dir / "events.jsonl")]
    assert "answered" in events


def test_answer_ignores_non_blocked_task(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.RUNNING
    control_write(d.run_dir, "answer", "001", text="does not matter")
    asyncio.run(d._poll_control())
    assert d.state["001"] is TaskState.RUNNING


def test_answer_without_text_is_ignored(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.BLOCKED
    control_write(d.run_dir, "answer", "001", text="   ")
    asyncio.run(d._poll_control())
    # No usable answer: the task stays blocked rather than silently re-queuing.
    assert d.state["001"] is TaskState.BLOCKED


def test_retry_ignores_running_task(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.RUNNING
    control_write(d.run_dir, "retry", "001")
    asyncio.run(d._poll_control())
    assert d.state["001"] is TaskState.RUNNING


def test_approve_moves_parked_task_to_merge_queue(tmp_path, repo):
    from factory import worktree as wt_mod
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    d._awaiting[task.id] = (task, wt)
    d.state[task.id] = TaskState.AWAITING_APPROVAL
    control_write(d.run_dir, "approve", task.id)
    asyncio.run(d._poll_control())
    assert d.state[task.id] is TaskState.MERGE_QUEUED
    assert task.id not in d._awaiting
    assert d._merge_q.qsize() == 1
    events = [e["event"] for e in EventLog.replay(d.run_dir / "events.jsonl")]
    assert "approved" in events


def test_changes_requeues_parked_task_with_operator_notes(tmp_path, repo):
    from factory import worktree as wt_mod
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    task.attempts = 2
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    d._awaiting[task.id] = (task, wt)
    d.state[task.id] = TaskState.AWAITING_APPROVAL
    control_write(d.run_dir, "changes", task.id, text="Also handle the empty case")
    asyncio.run(d._poll_control())
    assert d.state[task.id] is TaskState.QUEUED
    assert task.attempts == 0
    assert task.id not in d._awaiting
    assert "Also handle the empty case" in task.failure_notes[-1]
    # The throwaway branch is gone so the next attempt starts clean.
    assert not wt.path.exists()
    events = [e["event"] for e in EventLog.replay(d.run_dir / "events.jsonl")]
    assert "changes_requested" in events


def test_kill_discards_a_task_awaiting_approval(tmp_path, repo):
    # "Delete before merge": a ticket parked in AWAITING_APPROVAL has no live
    # worker, so kill must discard its validated branch and drop the ticket.
    from factory import worktree as wt_mod
    d = make_dispatcher(tmp_path, repo)
    task = d.tasks[0]
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    d._awaiting[task.id] = (task, wt)
    d.state[task.id] = TaskState.AWAITING_APPROVAL
    control_write(d.run_dir, "kill", task.id)
    asyncio.run(d._poll_control())
    assert d.state[task.id] is TaskState.FAILED
    assert task.id not in d._awaiting
    assert not wt.path.exists()  # the validated branch is thrown away
    failures = [e for e in EventLog.replay(d.run_dir / "events.jsonl") if e["event"] == "failure"]
    assert "cancelled by the operator before merge" in failures[0]["reason"]


def test_kill_cancels_a_queued_task(tmp_path, repo):
    # "Delete before merge" for work that hasn't started: it must never launch.
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.QUEUED
    control_write(d.run_dir, "kill", "001")
    asyncio.run(d._poll_control())
    assert d.state["001"] is TaskState.FAILED
    failures = [e for e in EventLog.replay(d.run_dir / "events.jsonl") if e["event"] == "failure"]
    assert "before it started" in failures[0]["reason"]


def test_retryable_failure_parks_worktree_and_resumes_session(tmp_path, repo):
    # A later-stage failure (review rejection, merge conflict) with a known agent
    # session must PARK the worktree and resume that session next attempt, not
    # throw the work away and restart cold.
    from factory import worktree as wt_mod
    d = make_dispatcher(tmp_path, repo, max_retries="2")
    task = d.tasks[0]
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    asyncio.run(d._retryable_failure(task, wt, "sess-abc", "review rejected: scope creep"))
    assert d.state[task.id] is TaskState.QUEUED
    assert task.resume_session == "sess-abc"
    assert d._parked_retry.get(task.id) is wt
    assert wt.path.exists()  # kept for the resumed attempt, not removed
    wt_mod.remove(wt, delete_branch=True)  # cleanup


def test_retryable_failure_without_session_removes_worktree(tmp_path, repo):
    # No session to resume -> fall back to the cold-restart behaviour (remove).
    from factory import worktree as wt_mod
    d = make_dispatcher(tmp_path, repo, max_retries="2")
    task = d.tasks[0]
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    asyncio.run(d._retryable_failure(task, wt, None, "merge failed"))
    assert d.state[task.id] is TaskState.QUEUED
    assert task.resume_session is None
    assert task.id not in d._parked_retry
    assert not wt.path.exists()


def test_approve_ignores_task_not_awaiting(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    d.state["001"] = TaskState.RUNNING
    control_write(d.run_dir, "approve", "001")
    asyncio.run(d._poll_control())
    assert d.state["001"] is TaskState.RUNNING
    assert d._merge_q.qsize() == 0


def test_pause_resume_and_stop_flags(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    control_write(d.run_dir, "pause")
    asyncio.run(d._poll_control())
    assert d._manual_pause
    control_write(d.run_dir, "resume")
    asyncio.run(d._poll_control())
    assert not d._manual_pause
    assert d._pause_until == 0.0  # resume also overrides a rate-limit pause
    control_write(d.run_dir, "stop")
    asyncio.run(d._poll_control())
    assert d._stopped
    events = [e["event"] for e in EventLog.replay(d.run_dir / "events.jsonl")]
    assert events.count("control") == 3
    assert "paused_manual" in events and "resumed" in events and "stopped" in events


def test_commands_are_applied_exactly_once(tmp_path, repo):
    d = make_dispatcher(tmp_path, repo)
    control_write(d.run_dir, "pause")
    asyncio.run(d._poll_control())
    d._manual_pause = False
    asyncio.run(d._poll_control())  # same file, no new lines: must not re-apply
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
