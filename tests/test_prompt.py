"""The coding-agent prompt is layered deterministically. Pure — no subprocess,
no git — so the ordering and opt-in sections are pinned here."""

from __future__ import annotations

from pathlib import Path

from factory.agent import build_prompt
from factory.task import Task


def _task(**kw) -> Task:
    base = dict(
        id="001", title="Do the thing", repo=Path("."), base_branch="main",
        body="Change X to Y.", path=Path("001.md"),
    )
    base.update(kw)
    return Task(**base)  # type: ignore[arg-type]


def test_architecture_notes_injected_and_labelled():
    prompt = build_prompt(
        _task(), "CONTRACT", architecture="- Header nav lives in ProjectSwitcher.",
    )
    assert "# Architecture notes" in prompt
    assert "Header nav lives in ProjectSwitcher." in prompt
    # Honoured, not merely present.
    assert "honour these" in prompt.lower()


def test_no_architecture_section_when_empty():
    prompt = build_prompt(_task(), "CONTRACT")
    assert "# Architecture notes" not in prompt


def test_layer_ordering_map_then_arch_then_ticket_then_coord():
    prompt = build_prompt(
        _task(), "CONTRACT",
        project_brief="MAP", architecture="ARCH",
        lessons="LESSON", coordination="SIBLINGS",
    )
    i_map = prompt.index("# Project map")
    i_arch = prompt.index("# Architecture notes")
    i_ticket = prompt.index("# Ticket")
    i_lessons = prompt.index("# Lessons from earlier work")
    i_coord = prompt.index("# Shared workspace")
    assert i_map < i_arch < i_ticket < i_lessons < i_coord


def test_resumed_retry_ignores_architecture():
    # A resumed session already carries all context — only the feedback is new.
    task = _task(resume_session="sess-123", failure_notes=["tests failed"])
    prompt = build_prompt(task, "CONTRACT", architecture="ARCH", project_brief="MAP")
    assert "# Architecture notes" not in prompt
    assert "ARCH" not in prompt
    assert "tests failed" in prompt
