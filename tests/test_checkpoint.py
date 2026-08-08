"""Per-tool worktree checkpoints and single-step undo."""

from __future__ import annotations

from pathlib import Path

from conftest import git as raw_git
from conftest import write_ticket
from factory.agent import build_command
from factory.checkpoint import CHECKPOINT_MARK, list_checkpoints, make_checkpoint, undo_to
from factory.config import AgentConfig
from factory.task import load_backlog


def test_checkpoint_commits_changes_and_returns_sha(repo: Path):
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    sha = make_checkpoint(repo, "Wrote a.txt")

    assert sha and len(sha) == 40
    # The commit landed with the marker subject and the label.
    subject = raw_git(repo, "log", "-1", "--format=%s")
    assert subject == f"{CHECKPOINT_MARK}: Wrote a.txt"


def test_checkpoint_is_a_noop_when_nothing_changed(repo: Path):
    # No edits since the base commit → nothing to record, no error.
    assert make_checkpoint(repo, "nothing") is None
    # And it did not create an empty commit.
    assert raw_git(repo, "rev-list", "--count", "HEAD") == "1"


def test_list_checkpoints_only_returns_marked_commits_oldest_first(repo: Path):
    # The agent works on a scratch branch off main — that is the range Warden lists.
    raw_git(repo, "checkout", "-b", "work")
    (repo / "a.txt").write_text("1\n", encoding="utf-8")
    first = make_checkpoint(repo, "step one")
    # An unmarked commit in between (as the agent's own commit would be).
    (repo / "b.txt").write_text("2\n", encoding="utf-8")
    raw_git(repo, "add", "-A")
    raw_git(repo, "commit", "-m", "agent's own commit")
    (repo / "c.txt").write_text("3\n", encoding="utf-8")
    second = make_checkpoint(repo, "step two")

    cps = list_checkpoints(repo, "main")
    # Only the two marked commits come back, oldest first — the agent's own commit
    # and the base history are filtered out.
    assert [c["sha"] for c in cps] == [first, second]
    assert [c["label"] for c in cps] == ["step one", "step two"]
    assert all(c["short"] == c["sha"][:8] for c in cps)


def test_undo_to_rewinds_the_worktree_to_a_checkpoint(repo: Path):
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    first = make_checkpoint(repo, "one")
    (repo / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    make_checkpoint(repo, "two")
    assert (repo / "a.txt").read_text(encoding="utf-8") == "one\ntwo\n"

    undo_to(repo, first)

    # The working tree and HEAD are back at the first checkpoint.
    assert (repo / "a.txt").read_text(encoding="utf-8") == "one\n"
    assert raw_git(repo, "rev-parse", "HEAD") == first


def test_build_command_injects_checkpoint_hook_only_when_enabled(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    task = load_backlog(backlog, "main")[0]

    # command=("python",) so PATH resolution succeeds on CI without the real CLI.
    off = build_command(AgentConfig(command=("python",)), task)
    assert "--settings" not in off

    on = build_command(AgentConfig(command=("python",), checkpoints=True), task)
    assert "--settings" in on
    settings = on[on.index("--settings") + 1]
    assert "PostToolUse" in settings
    assert "factory checkpoint" in settings
