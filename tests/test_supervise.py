"""Supervisor agent: conversational exchanges with session continuity."""

from __future__ import annotations

import asyncio
from pathlib import Path

from factory.supervise import _clean_suggestions, ask, format_answer, reset
from test_e2e import make_config


def test_clean_suggestions_keeps_only_executable_proposals():
    raw = [
        {"op": "retry", "task": "004", "label": "Retry 004"},   # ok
        {"op": "kill", "label": "Kill it"},                      # dropped: kill needs a task
        {"op": "pause", "label": "Pause the run"},               # ok (no task needed)
        {"op": "delete", "task": "004", "label": "nuke"},        # dropped: op not allowed
        {"op": "stop"},                                          # ok, label defaults
        "not-a-dict",                                            # dropped
    ]
    out = _clean_suggestions(raw)
    assert out == [
        {"op": "retry", "label": "Retry 004", "task": "004"},
        {"op": "pause", "label": "Pause the run"},
        {"op": "stop", "label": "Stop"},
    ]
    assert _clean_suggestions(None) == []
    assert _clean_suggestions("nope") == []


def test_clean_suggestions_keeps_plan_with_a_goal():
    # A plan needs a goal; the goal is trimmed and the label defaults to "Draft tickets".
    raw = [
        {"op": "plan", "goal": "  Add a dark-mode toggle  ", "label": "Draft tickets"},
        {"op": "plan", "label": "no goal"},        # dropped: no goal
        {"op": "plan", "goal": "", "label": "x"},  # dropped: blank goal
        {"op": "plan", "goal": "Just a goal"},     # kept: label defaults
    ]
    out = _clean_suggestions(raw)
    assert out == [
        {"op": "plan", "goal": "Add a dark-mode toggle", "label": "Draft tickets"},
        {"op": "plan", "goal": "Just a goal", "label": "Draft tickets"},
    ]


def ask_sync(workdir: Path, message: str) -> dict:
    return asyncio.run(ask(make_config(), workdir, message, workdir / "sup.jsonl"))


def test_first_exchange_creates_a_session(tmp_path):
    answer = ask_sync(tmp_path, "how is the run going?")
    assert "running" in answer["reply"]
    assert (tmp_path / ".supervisor-session").read_text(encoding="utf-8") == \
        "stub-supervisor-session"


def test_second_exchange_resumes_the_conversation(tmp_path):
    ask_sync(tmp_path, "first question")
    answer = ask_sync(tmp_path, "and now?")
    # The stub answers differently when it receives a bare message (no contract),
    # which proves the resumed path sent only the message.
    assert answer["reply"].startswith("resumed:")
    assert "and now?" in answer["reply"]


def test_reset_forgets_the_conversation(tmp_path):
    ask_sync(tmp_path, "first")
    reset(tmp_path)
    assert not (tmp_path / ".supervisor-session").exists()
    answer = ask_sync(tmp_path, "again")
    assert not answer["reply"].startswith("resumed:")  # fresh contract prompt again


def test_format_answer_lists_actions():
    text = format_answer({"reply": "Killed task 003.", "actions": ["appended kill 003"]})
    assert "Killed task 003." in text
    assert "appended kill 003" in text
