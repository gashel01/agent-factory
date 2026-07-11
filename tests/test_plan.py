"""`factory plan`: co-created tickets are valid backlog files, IDs renumbered."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from conftest import write_ticket
from factory.plan import PlanError, run_planner, write_drafts
from factory.task import load_backlog
from test_e2e import make_config

STUB = Path(__file__).parent / "stub_agent.py"


def plan(tmp_path: Path, repo: Path) -> dict:
    cfg = make_config()
    return asyncio.run(run_planner(cfg, repo, "add text utilities", tmp_path / "plan.jsonl"))


def test_planner_returns_tickets_and_drafts_are_loadable(tmp_path, repo):
    contract = plan(tmp_path, repo)
    backlog = tmp_path / "backlog"
    written = write_drafts(contract["tickets"], backlog, repo)
    assert len(written) == 2

    tasks = load_backlog(backlog, "main")  # parses, validates ids/deps/repo
    assert [t.id for t in tasks] == ["001", "002"]
    assert tasks[1].depends_on == ("001",)
    assert tasks[0].verify_commands
    assert "## Success criteria" in tasks[0].body


def test_drafts_extend_an_existing_backlog_without_id_clash(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "004", repo)  # pre-existing manual ticket
    contract = plan(tmp_path, repo)
    write_drafts(contract["tickets"], backlog, repo)

    tasks = load_backlog(backlog, "main")
    ids = sorted(t.id for t in tasks)
    assert ids == ["004", "005", "006"]  # renumbered after the highest existing
    dep = next(t for t in tasks if t.id == "006")
    assert dep.depends_on == ("005",)  # internal references remapped too


def test_planner_error_is_actionable(tmp_path, repo, monkeypatch):
    cfg = make_config()
    bad = make_config(agent=cfg.agent.__class__(command=(sys.executable, "-c", "exit(3)")))
    with pytest.raises(PlanError, match="without a result"):
        asyncio.run(run_planner(bad, repo, "goal", tmp_path / "plan.jsonl"))
