from __future__ import annotations

from conftest import git
from factory.hotspots import brief_for_planner, scan_hotspots


def _commit(repo, rel: str, size: int) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x" * size, encoding="utf-8")
    git(repo, "add", rel)
    git(repo, "commit", "-m", f"add {rel}")


def test_flags_oversized_source_file(repo):
    _commit(repo, "big.py", 40_000)   # ~10k tokens
    _commit(repo, "small.py", 200)
    spots = scan_hotspots(repo, min_tokens=6000)
    paths = [h.path for h in spots]
    assert "big.py" in paths
    assert "small.py" not in paths


def test_ignores_generated_and_data_files(repo):
    # A minified bundle and a data blob are big but must never be flagged.
    _commit(repo, "app.min.js", 80_000)
    _commit(repo, "data.json", 80_000)
    _commit(repo, "package-lock.json", 80_000)
    assert scan_hotspots(repo, min_tokens=6000) == []


def test_ranks_hot_file_above_a_frozen_one(repo):
    # Two equally large files; the one edited more recently ranks higher because
    # churn is the proxy for centrality.
    _commit(repo, "frozen.py", 40_000)
    _commit(repo, "hot.py", 40_000)
    for i in range(3):
        # Distinct content each pass so every commit is a real change (churn).
        (repo / "hot.py").write_text("x" * (40_000 + (i + 1) * 100), encoding="utf-8")
        git(repo, "add", "hot.py")
        git(repo, "commit", "-m", f"touch hot {i}")
    spots = scan_hotspots(repo, min_tokens=6000)
    assert spots[0].path == "hot.py"
    assert spots[0].edits > next(h for h in spots if h.path == "frozen.py").edits


def test_brief_for_planner_is_empty_without_hotspots(repo):
    _commit(repo, "small.py", 100)
    assert brief_for_planner(scan_hotspots(repo)) == ""


def test_brief_for_planner_lists_files_and_advises_split(repo):
    _commit(repo, "huge.tsx", 120_000)
    note = brief_for_planner(scan_hotspots(repo, min_tokens=6000))
    assert "huge.tsx" in note
    assert "split" in note.lower()


def test_non_git_path_returns_empty(tmp_path):
    assert scan_hotspots(tmp_path) == []
