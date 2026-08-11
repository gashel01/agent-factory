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


def test_merge_lands_despite_dirty_base(tmp_path, repo, task):
    """The operator can edit the base checkout in parallel: a dirty tree no longer
    blocks the merge — their WIP is stashed, the merge lands, the WIP is restored."""
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "output_001.txt")
    # Uncommitted operator edit to a DIFFERENT file in the base checkout.
    (repo / "README.md").write_text("# test repo\nWIP by the operator\n", encoding="utf-8")
    assert not wt_mod.is_clean(repo)

    result = merge_branch(task, wt, VerifyConfig())

    assert result.ok, result.reason
    assert not result.warning  # different files → clean restore, no conflict
    assert "output_001.txt" in git(repo, "show", "main", "--stat")  # ticket landed
    assert "WIP by the operator" in (repo / "README.md").read_text(encoding="utf-8")  # WIP restored
    assert not wt.path.exists()


def test_merge_warns_when_operator_edits_ticket_file(tmp_path, repo, task):
    """When the operator's uncommitted edit overlaps the ticket's own change, the
    merge still lands but flags a conflict — and their work stays recoverable."""
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    (wt.path / "README.md").write_text("# test repo\nticket line\n", encoding="utf-8")
    git(wt.path, "add", "README.md")
    git(wt.path, "commit", "-m", "feat: ticket edits README")
    # Operator edits the SAME line region in the base checkout.
    (repo / "README.md").write_text("# test repo\noperator line\n", encoding="utf-8")

    result = merge_branch(task, wt, VerifyConfig())

    assert result.ok, result.reason  # the merge still lands
    assert result.warning            # but flags the overlap for a manual reconcile
    assert "ticket line" in git(repo, "show", "main:README.md")  # ticket's change is in main
    assert git(repo, "stash", "list").strip() != ""  # operator's work is not lost


def test_merge_skips_reverify_when_base_did_not_move(tmp_path, repo, task):
    # The dispatcher already verified this branch; if the base has not advanced
    # under it, the rebase replays nothing and re-running verify is pure waste.
    # A verify command that WOULD fail must not even run: the merge still lands.
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "output_001.txt")
    result = merge_branch(task, wt, VerifyConfig(commands=('python -c "exit(1)"',)))
    assert result.ok, result.reason
    assert result.reverified is False
    assert "output_001.txt" in git(repo, "show", "main", "--stat")


def test_merge_reverifies_when_base_moved(tmp_path, repo, task):
    # A sibling landed on base after this worktree branched: the rebase replays
    # the ticket's commit, so the world changed and re-verify MUST run — a failing
    # command now blocks the merge instead of being skipped.
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", task.id, "main")
    _commit_in(wt, "output_001.txt")
    (repo / "sibling.txt").write_text("landed\n", encoding="utf-8")
    git(repo, "add", "sibling.txt")
    git(repo, "commit", "-m", "feat: a sibling landed on base")
    result = merge_branch(task, wt, VerifyConfig(commands=('python -c "exit(1)"',)))
    assert not result.ok
    assert "post-rebase verify failed" in result.reason


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
