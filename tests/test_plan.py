"""`factory plan`: co-created tickets are valid backlog files, IDs renumbered."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from conftest import write_ticket
from factory.plan import PlanError, read_brief, run_planner, write_brief, write_drafts
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


def test_string_files_hint_is_wrapped_not_split_into_chars(tmp_path, repo):
    # A planner returning a bare string for files_hint/depends_on/verify must be
    # wrapped into a one-element list — never list("src/x.py") = ['s','r','c',…],
    # which would corrupt collision detection (the 019/020 duplicate-work bug).
    tickets = [{
        "id": "001", "title": "T", "files_hint": "src/App.tsx",
        "depends_on": [], "verify": "npm test", "priority": 1, "timeout_min": 15,
        "body": "## Context\n.\n## Success criteria\n.\n## Out of scope\n.",
    }]
    written = write_drafts(tickets, tmp_path / "backlog", repo)
    task = load_backlog(tmp_path / "backlog", "main")[0]
    assert task.files_hint == ("src/App.tsx",)
    assert task.verify_commands == ("npm test",)
    assert len(written) == 1


def test_non_numeric_planner_priority_raises_plan_error(tmp_path, repo):
    tickets = [{"id": "001", "title": "T", "priority": "high", "body": "x"}]
    with pytest.raises(PlanError, match="non-numeric priority"):
        write_drafts(tickets, tmp_path / "backlog", repo)


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


def test_numbering_stays_monotonic_past_archived_tickets(tmp_path, repo):
    # A merged ticket lives in backlog/done/ with a run-id filename prefix; its
    # real id is in the front matter. New drafts must number ABOVE it so a fresh
    # plan on an emptied backlog can't reuse a past id (which would collide on
    # the cumulative board).
    backlog = tmp_path / "backlog"
    done = backlog / "done"
    done.mkdir(parents=True)
    write_ticket(done, "008", repo)
    # rename to the run-prefixed form the dispatcher actually writes
    (done / "008.md").rename(done / "2026-07-12_120000-008-slug.md")

    contract = plan(tmp_path, repo)
    written = write_drafts(contract["tickets"], backlog, repo)
    ids = sorted(p.stem.split("-")[0] for p in written)
    assert ids[0] == "009"  # first new id sits above the archived 008


def test_project_brief_round_trips(tmp_path):
    repo = tmp_path / "repoA"
    assert read_brief(tmp_path, repo) == ""  # nothing yet
    write_brief(tmp_path, repo, "  My project map.  ")
    assert read_brief(tmp_path, repo).strip() == "My project map."
    write_brief(tmp_path, repo, "   ")  # blank is ignored, keeps the last good map
    assert read_brief(tmp_path, repo).strip() == "My project map."


def test_project_brief_is_scoped_per_repo(tmp_path):
    # The bug this guards: one workspace reused across two projects must never
    # serve repo A's map when planning repo B.
    repo_a = tmp_path / "coupe-du-monde"
    repo_b = tmp_path / "doodle"
    write_brief(tmp_path, repo_a, "Map of the World Cup site.")
    assert read_brief(tmp_path, repo_b) == ""  # a fresh repo inherits nothing
    write_brief(tmp_path, repo_b, "Map of the doodle game.")
    assert read_brief(tmp_path, repo_a).strip() == "Map of the World Cup site."
    assert read_brief(tmp_path, repo_b).strip() == "Map of the doodle game."


def test_planner_emits_a_brief_and_reuses_a_prior_one(tmp_path, repo):
    cfg = make_config()
    first = asyncio.run(run_planner(cfg, repo, "add text utilities", tmp_path / "p1.jsonl"))
    assert first["brief"] == "Stub project map."  # a fresh scan, no map injected

    # Feed the saved map back in: the planner must receive it (not re-scan blind).
    reused = asyncio.run(
        run_planner(cfg, repo, "add more utilities", tmp_path / "p2.jsonl", first["brief"])
    )
    assert "[reused]" in reused["brief"]


def test_planner_error_is_actionable(tmp_path, repo, monkeypatch):
    cfg = make_config()
    bad = make_config(agent=cfg.agent.__class__(command=(sys.executable, "-c", "exit(3)")))
    with pytest.raises(PlanError, match="without a result"):
        asyncio.run(run_planner(bad, repo, "goal", tmp_path / "plan.jsonl"))
