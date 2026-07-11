"""Post-worktree setup hooks: dependency install before the agent starts."""

from __future__ import annotations

from dataclasses import replace

from conftest import write_ticket
from factory.config import SetupConfig
from factory.events import EventLog
from test_e2e import make_config, run_dispatcher


def test_setup_runs_in_worktree_before_agent(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    # The marker is written by setup and must exist while the agent runs;
    # the stub commits output_001.txt, so DONE proves the full chain ran.
    cfg = replace(
        make_config(),
        setup=SetupConfig(commands=('python -c "open(\'setup_ran.txt\', \'w\').write(\'ok\')"',)),
    )

    counts = run_dispatcher(cfg, backlog, tmp_path / "run")

    assert counts == {"DONE": 1}
    events = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
              if e["event"] == "setup"]
    assert events and events[0]["ok"] is True


def test_setup_failure_fails_task_without_burning_retries(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, max_retries=2)
    cfg = replace(make_config(), setup=SetupConfig(commands=('python -c "exit(7)"',)))

    counts = run_dispatcher(cfg, backlog, tmp_path / "run")

    assert counts == {"FAILED": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    # Environment problem: fails directly, no retry events despite max_retries=2
    assert not [e for e in events if e["event"] == "retry"]
    failure = next(e for e in events if e["event"] == "failure")
    assert "setup" in failure["reason"] and "exited 7" in failure["reason"]
