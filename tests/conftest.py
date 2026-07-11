from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return proc.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A minimal real git repository on branch main with one commit."""
    path = tmp_path / "repo"
    path.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(path)], capture_output=True, check=True)
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "user.name", "Test")
    (path / "README.md").write_text("# test repo\n", encoding="utf-8")
    git(path, "add", ".")
    git(path, "commit", "-m", "init")
    return path


def write_ticket(backlog: Path, task_id: str, repo: Path, body: str = "", **meta: object) -> Path:
    backlog.mkdir(exist_ok=True)
    front = [f'id: "{task_id}"', f"title: Task {task_id}", f"repo: {repo.as_posix()}"]
    for key, value in meta.items():
        front.append(f"{key}: {value}")
    path = backlog / f"{task_id}.md"
    path.write_text(
        "---\n" + "\n".join(front) + "\n---\n\n## Goal\n" + (body or f"Do task {task_id}.\n"),
        encoding="utf-8",
    )
    return path
