"""SWE-bench harness plumbing, proven end-to-end with the stub agent — no
tokens, no Docker, no network. Verifies: an instance is checked out at its base
commit, the pipeline runs, a real patch is extracted, and the prediction is in
the format the official evaluator consumes."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from benchmarks.swebench.dataset import Instance, load_local, take_slice
from benchmarks.swebench.harness import ABLATION, run_instance

from factory.config import AgentConfig, Config

STUB = Path(__file__).parent / "stub_agent.py"


def _stub_cfg() -> Config:
    return Config(agent=AgentConfig(command=(sys.executable, str(STUB))))


def _make_repo(root: Path) -> tuple[Path, str]:
    """A tiny git repo with a buggy file; returns (clone_path, base_commit)."""
    repo = root / "repo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], capture_output=True, check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "t@e.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "T"], check=True)
    (repo / "buggy.py").write_text("def f():\n    return 1  # should be 2\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-m", "init"], capture_output=True, check=True
    )
    sha = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    return repo, sha


def _instance(clone: Path, sha: str, cache: Path) -> Instance:
    # Pre-place the clone where ensure_clone expects it, so no network fetch.
    inst = Instance(
        instance_id="acme__widget-1", repo="acme/widget", base_commit=sha,
        problem_statement="f() returns 1 but should return 2.",
    )
    dest = cache / inst.repo.replace("/", "__")
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", str(clone), str(dest)], capture_output=True, check=True)
    subprocess.run(["git", "-C", str(dest), "config", "user.email", "t@e.com"], check=True)
    subprocess.run(["git", "-C", str(dest), "config", "user.name", "T"], check=True)
    return inst


def test_run_instance_produces_a_patch_and_prediction(tmp_path):
    clone_src, sha = _make_repo(tmp_path)
    cache = tmp_path / "cache"
    inst = _instance(clone_src, sha, cache)
    clone = cache / inst.repo.replace("/", "__")

    res = asyncio.run(run_instance(
        _stub_cfg(), inst, clone, tmp_path / "work", ABLATION["bare"], tmp_path / "logs"
    ))

    assert res.status == "produced"
    assert res.instance_id == "acme__widget-1"
    assert res.model_patch.strip()  # the stub committed a file → a real diff
    assert "diff --git" in res.model_patch
    pred = res.prediction("agent-factory-bare")
    assert pred["instance_id"] == "acme__widget-1"
    assert pred["model_name_or_path"] == "agent-factory-bare"
    assert pred["model_patch"] == res.model_patch
    # the per-instance worktree is cleaned up
    assert not (tmp_path / "work" / "acme__widget-1").exists()


def test_review_config_runs_the_reviewer(tmp_path):
    # The 'review' config exercises the adversarial reviewer path; the stub
    # approves, so a patch is still produced (one attempt, no rejection loop).
    clone_src, sha = _make_repo(tmp_path)
    cache = tmp_path / "cache"
    inst = _instance(clone_src, sha, cache)
    clone = cache / inst.repo.replace("/", "__")

    res = asyncio.run(run_instance(
        _stub_cfg(), inst, clone, tmp_path / "work", ABLATION["review"], tmp_path / "logs"
    ))
    assert res.status == "produced"
    assert res.config == "review"


def test_local_dataset_load_and_slice(tmp_path):
    f = tmp_path / "slice.jsonl"
    f.write_text(
        '{"instance_id": "a__b-1", "repo": "a/b", "base_commit": "abc", '
        '"problem_statement": "x"}\n'
        '{"instance_id": "a__b-2", "repo": "a/b", "base_commit": "def", '
        '"problem_statement": "y"}\n',
        encoding="utf-8",
    )
    instances = load_local(f)
    assert [i.instance_id for i in instances] == ["a__b-1", "a__b-2"]
    assert [i.instance_id for i in take_slice(instances, 1, None)] == ["a__b-1"]
    assert [i.instance_id for i in take_slice(instances, None, ["a__b-2"])] == ["a__b-2"]
