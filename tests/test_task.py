from __future__ import annotations

import pytest

from conftest import write_ticket
from factory.task import TicketError, load_backlog, parse_ticket


def test_parse_minimal_ticket(tmp_path, repo):
    path = write_ticket(tmp_path / "backlog", "001", repo)
    task = parse_ticket(path, "main")
    assert task.id == "001"
    assert task.repo == repo
    assert task.base_branch == "main"
    assert task.max_retries == 2
    assert "Do task 001" in task.body


def test_parse_full_front_matter(tmp_path, repo):
    backlog = tmp_path / "backlog"
    backlog.mkdir()
    (backlog / "002.md").write_text(
        f"""---
id: 002
title: Full ticket
repo: {repo.as_posix()}
base_branch: develop
files_hint: [src/auth/, tests/test_auth.py]
depends_on: ["001"]
priority: 1
max_retries: 0
budget:
  timeout_min: 5
  max_turns: 10
verify:
  - pytest -q
---
body
""",
        encoding="utf-8",
    )
    task = parse_ticket(backlog / "002.md", "main")
    assert task.base_branch == "develop"
    assert task.budget.timeout_min == 5
    assert task.verify_commands == ("pytest -q",)
    assert task.depends_on == ("001",)


@pytest.mark.parametrize(
    ("content", "fragment"),
    [
        ("no front matter", "missing YAML front matter"),
        ("---\nid: 1\n", "unterminated"),
        ("---\ntitle: x\nrepo: .\n---\nbody", "missing required field 'id'"),
    ],
)
def test_parse_errors_are_actionable(tmp_path, content, fragment):
    path = tmp_path / "bad.md"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(TicketError, match=fragment):
        parse_ticket(path, "main")


def test_unknown_budget_key_rejected(tmp_path, repo):
    path = write_ticket(tmp_path / "backlog", "003", repo, budget="{timeout_min: 5, tokens: 9}")
    with pytest.raises(TicketError, match="unknown budget keys"):
        parse_ticket(path, "main")


def test_collision_rules(tmp_path, repo):
    backlog = tmp_path / "backlog"
    a = parse_ticket(write_ticket(backlog, "a", repo, files_hint="[src/auth/]"), "main")
    b = parse_ticket(write_ticket(backlog, "b", repo, files_hint="[src/auth/jwt.py]"), "main")
    c = parse_ticket(write_ticket(backlog, "c", repo, files_hint="[src/auth2/]"), "main")
    d = parse_ticket(write_ticket(backlog, "d", repo), "main")  # no hint = collides with all
    assert a.collides_with(b) and b.collides_with(a)
    assert not a.collides_with(c)  # prefix must respect path boundaries
    assert a.collides_with(d) and c.collides_with(d)


def test_backlog_rejects_duplicate_ids_and_unknown_deps(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    (backlog / "001bis.md").write_text(
        (backlog / "001.md").read_text(encoding="utf-8"), encoding="utf-8"
    )
    with pytest.raises(TicketError, match="duplicate task id"):
        load_backlog(backlog, "main")
    (backlog / "001bis.md").unlink()
    write_ticket(backlog, "002", repo, depends_on='["ghost"]')
    with pytest.raises(TicketError, match="unknown ids"):
        load_backlog(backlog, "main")


def test_dependency_on_archived_ticket_is_satisfied(tmp_path, repo):
    # Regression (live, 2026-07-11): ticket 001 merged and archived to done/,
    # then a follow-up run failed validation because 002's depends_on ["001"]
    # no longer resolved. Archived dependencies must count as satisfied.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "002", repo, depends_on='["001"]')
    done = backlog / "done"
    done.mkdir()
    (backlog / "001.md").write_text("---\nid: \"001\"\ntitle: t\nrepo: .\n---\nx",
                                    encoding="utf-8")
    (backlog / "001.md").rename(done / "run-001.md")

    tasks = load_backlog(backlog, "main")

    assert tasks[0].id == "002"
    assert tasks[0].depends_on == ()  # satisfied dependency dropped

    # but a truly unknown id still fails loudly
    write_ticket(backlog, "003", repo, depends_on='["ghost"]')
    with pytest.raises(TicketError, match="unknown ids"):
        load_backlog(backlog, "main")


def test_render_includes_failure_notes(tmp_path, repo):
    task = parse_ticket(write_ticket(tmp_path / "backlog", "001", repo), "main")
    task.failure_notes.append("pytest exited 1: assertion failed")
    rendered = task.render()
    assert "Ticket ID: 001" in rendered
    assert "Previous attempt feedback" in rendered
    assert "pytest exited 1" in rendered
