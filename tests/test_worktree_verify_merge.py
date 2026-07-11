from __future__ import annotations

import pytest

from conftest import git, write_ticket
from factory import worktree as wt_mod
from factory.config import VerifyConfig
from factory.merge import merge_branch
from factory.task import parse_ticket
from factory.verify import run_verify
from factory.worktree import GitError, preflight


@pytest.fixture
def task(tmp_path, repo):
    return parse_ticket(write_ticket(tmp_path / "backlog", "001", repo), "main")


def _commit_in(wt, name: str, content: str = "x\n"):
    (wt.path / name).write_text(content, encoding="utf-8")
    git(wt.path, "add", name)
    git(wt.path, "commit", "-m", f"feat: add {name}")


def test_worktree_create_and_remove(tmp_path, repo, task):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    assert wt.path.exists()
    assert wt.branch == "agent/run1/001"
    wt_mod.remove(wt, delete_branch=True)
    assert not wt.path.exists()
    assert "agent/run1/001" not in git(repo, "branch", "--list", "agent/*")


def test_verify_rejects_empty_branch(tmp_path, repo, task):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    result = run_verify(task, wt.path, VerifyConfig())
    assert not result.ok
    assert "no commits" in result.failures[0]


def test_verify_runs_commands(tmp_path, repo, task):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "output_001.txt")
    ok = run_verify(task, wt.path, VerifyConfig(commands=('python -c "exit(0)"',)))
    assert ok.ok
    ko = run_verify(task, wt.path, VerifyConfig(commands=('python -c "exit(3)"',)))
    assert not ko.ok
    assert "exited 3" in ko.failures[0]


def test_merge_lands_on_base(tmp_path, repo, task):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "output_001.txt")
    result = merge_branch(task, wt, VerifyConfig())
    assert result.ok, result.reason
    assert "output_001.txt" in git(repo, "show", "main", "--stat")
    assert not wt.path.exists()  # merge cleans up its worktree


def test_merge_reports_conflict_and_aborts(tmp_path, repo, task):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "shared.txt", "agent version\n")
    # base moves with a conflicting change after the worktree was created
    (repo / "shared.txt").write_text("base version\n", encoding="utf-8")
    git(repo, "add", "shared.txt")
    git(repo, "commit", "-m", "conflicting base change")
    result = merge_branch(task, wt, VerifyConfig())
    assert not result.ok
    assert "conflict" in result.reason
    # the worktree is left rebase-free so cleanup can proceed
    assert git(wt.path, "status", "--porcelain") == ""


def test_preflight_rejects_dirty_repo(repo):
    (repo / "dirty.txt").write_text("x", encoding="utf-8")
    with pytest.raises(GitError, match="uncommitted changes"):
        preflight(repo, "main")


def test_preflight_rejects_wrong_branch(repo):
    git(repo, "checkout", "-b", "feature")
    with pytest.raises(GitError, match="expected 'main'"):
        preflight(repo, "main")
