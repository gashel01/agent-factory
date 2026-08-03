"""Lesson recall: reads the dashboard's memory files and injects the relevant
ones into the agent prompt. These tests exercise the dependency-free keyword
path (memorymcp is an optional extra and is not installed in CI)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from factory.memory import APPLIED_FILENAME, LessonStore, record_applications
from factory.task import Budget, Task


def _task(title: str, body: str = "") -> Task:
    return Task(
        id="007", title=title, repo=Path("."), base_branch="main",
        body=body, path=Path("x.md"), budget=Budget(),
    )


def _make_run(tmp_path: Path, project=None, glob=None) -> Path:
    ws = tmp_path / "ws"
    run_dir = ws / "runs" / "20260101-000000"
    run_dir.mkdir(parents=True)
    if project is not None:
        (ws / "memory.json").write_text(json.dumps({"facts": project}), encoding="utf-8")
    if glob is not None:
        (tmp_path / "memory.global.json").write_text(
            json.dumps({"facts": glob}), encoding="utf-8"
        )
    return run_dir


def _fact(text: str, scope: str = "project", ticket: str | None = None) -> dict:
    return {"id": "F", "text": text, "scope": scope, "ticketId": ticket, "createdTs": "x"}


def _recall(store: LessonStore, task: Task) -> str:
    async def go() -> str:
        await store.load()
        return (await store.recall(task)).text

    return asyncio.run(go())


def _recall_full(store: LessonStore, task: Task):
    async def go():
        await store.load()
        return await store.recall(task)

    return asyncio.run(go())


def test_no_memory_files_recalls_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    run_dir = _make_run(tmp_path)
    store = LessonStore.discover(run_dir)
    assert _recall(store, _task("anything")) == ""


def test_global_lessons_are_always_injected(tmp_path, monkeypatch):
    run_dir = _make_run(
        tmp_path,
        project=[_fact("Run the dashboard linter before every PR.", ticket="003")],
        glob=[_fact("Never commit AI attribution lines.", scope="global")],
    )
    monkeypatch.setenv("FACTORY_GLOBAL_MEMORY", str(tmp_path / "memory.global.json"))
    store = LessonStore.discover(run_dir)
    # A ticket totally unrelated to either lesson still gets the global rule.
    block = _recall(store, _task("Rename a CSS variable"))
    assert "Never commit AI attribution" in block


def test_relevant_project_lesson_surfaces_and_irrelevant_is_dropped(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    run_dir = _make_run(
        tmp_path,
        project=[
            _fact("Always run the linter before opening a dashboard PR.", ticket="003"),
            _fact("The auth token comes from the AUTH_ENV variable.", ticket="004"),
        ],
    )
    store = LessonStore.discover(run_dir)
    block = _recall(store, _task("Fix the linter step in the dashboard PR flow"))
    assert "linter" in block
    assert "AUTH_ENV" not in block  # no keyword overlap → not injected


def test_ticket_origin_is_shown(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    run_dir = _make_run(
        tmp_path, project=[_fact("Prefer composition over inheritance here.", ticket="003")]
    )
    store = LessonStore.discover(run_dir)
    block = _recall(store, _task("Refactor the composition helpers"))
    assert "(from 003)" in block


def test_malformed_memory_file_is_ignored(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    run_dir = _make_run(tmp_path)
    (tmp_path / "ws" / "memory.json").write_text("{ not json", encoding="utf-8")
    store = LessonStore.discover(run_dir)
    assert _recall(store, _task("anything")) == ""


def test_recall_reports_the_ids_it_injected(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    run_dir = _make_run(tmp_path, project=[
        {"id": "F-abc", "text": "Run the linter before every dashboard PR.",
         "scope": "project", "ticketId": None, "createdTs": "x"},
    ])
    store = LessonStore.discover(run_dir)
    recall = _recall_full(store, _task("Fix the linter step on the dashboard"))
    assert recall.text and "F-abc" in recall.fact_ids


def test_record_applications_counts_and_accumulates(tmp_path):
    record_applications(tmp_path, ["F-1", "F-2"])
    record_applications(tmp_path, ["F-1"])
    record_applications(tmp_path, [])  # no-op
    import json
    counts = json.loads((tmp_path / APPLIED_FILENAME).read_text(encoding="utf-8"))["counts"]
    assert counts == {"F-1": 2, "F-2": 1}


def test_lessons_are_capped(tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_GLOBAL_MEMORY", raising=False)
    # 20 lessons that all match the query; only the cap should be injected.
    project = [_fact(f"Rule number {i} about the dashboard build.") for i in range(20)]
    run_dir = _make_run(tmp_path, project=project)
    store = LessonStore.discover(run_dir)
    block = _recall(store, _task("dashboard build"))
    assert block.count("\n- ") + 1 <= 8
