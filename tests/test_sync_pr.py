"""Remote sync (behind/ahead + pull) and PR-native mode config/guards."""

from __future__ import annotations

import subprocess
from pathlib import Path

from conftest import git as cgit
from factory import worktree as wt
from factory.config import PrConfig, load_config


def _clone(origin: Path, dest: Path) -> Path:
    subprocess.run(["git", "clone", "-q", str(origin), str(dest)], check=True)
    cgit(dest, "config", "user.email", "t@t.co")
    cgit(dest, "config", "user.name", "t")
    return dest


def test_ahead_behind_and_pull_ff(tmp_path, repo):
    clone = _clone(repo, tmp_path / "clone")  # `repo` is the origin
    assert wt.remotes(clone) == ["origin"]
    assert wt.ahead_behind(clone, "main") == (0, 0)

    # Advance the origin — the clone is now one commit behind.
    (repo / "f.txt").write_text("x", encoding="utf-8")
    cgit(repo, "add", ".")
    cgit(repo, "commit", "-m", "remote work")
    wt.fetch(clone)
    assert wt.ahead_behind(clone, "main") == (0, 1)
    assert wt.pull_ff(clone, "main") is True
    assert wt.ahead_behind(clone, "main") == (0, 0)


def test_pull_ff_left_alone_when_ahead(tmp_path, repo):
    clone = _clone(repo, tmp_path / "clone")
    (clone / "local.txt").write_text("y", encoding="utf-8")
    cgit(clone, "add", ".")
    cgit(clone, "commit", "-m", "local work")
    wt.fetch(clone)
    ahead, behind = wt.ahead_behind(clone, "main")
    assert ahead == 1 and behind == 0
    # Purely ahead → the caller must NOT pull (nothing to fast-forward).


def test_ahead_behind_none_without_remote(repo):
    assert wt.remotes(repo) == []
    assert wt.ahead_behind(repo, "main") is None


def test_pr_config_parses(tmp_path):
    cfg = tmp_path / "factory.yaml"
    cfg.write_text("pr:\n  enabled: true\n", encoding="utf-8")
    assert load_config(cfg).pr == PrConfig(enabled=True)
    assert load_config(None).pr.enabled is False
