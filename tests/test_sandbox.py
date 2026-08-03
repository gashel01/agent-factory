"""Sandbox isolation: config parsing + the docker-wrap argv (pure logic, no daemon)."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory import sandbox, worktree
from factory.config import load_config


def test_config_parses_isolation(tmp_path: Path) -> None:
    cfg = tmp_path / "factory.yaml"
    cfg.write_text("execution:\n  isolation: sandbox\n", encoding="utf-8")
    assert load_config(cfg).isolation == "sandbox"
    # Default and any non-"sandbox" value stay direct (fast path, never boxed by surprise).
    assert load_config(None).isolation == "direct"
    cfg.write_text("execution:\n  isolation: direct\n", encoding="utf-8")
    assert load_config(cfg).isolation == "direct"


def test_wrap_swaps_host_exe_for_container_claude() -> None:
    base = ["C:\\Users\\me\\claude.EXE", "-p", "--max-turns", "6", "--allowedTools", "Write"]
    cmd = sandbox.wrap(base, Path("C:/work/wt/task-1"))
    # The host executable is dropped; the container runs its own `claude`.
    assert "C:\\Users\\me\\claude.EXE" not in cmd
    claude_i = cmd.index("claude")
    assert cmd[claude_i + 1 :] == ["-p", "--max-turns", "6", "--allowedTools", "Write"]
    # It's a docker run of the agent image.
    assert cmd[1] == "run" and sandbox.AGENT_IMAGE in cmd


def test_wrap_hardens_and_scopes() -> None:
    cmd = sandbox.wrap(["claude", "-p"], Path("C:/work/wt/task-1"))
    joined = " ".join(cmd)
    # Privilege + resource hardening present.
    assert "--cap-drop" in cmd and "ALL" in cmd
    assert "no-new-privileges" in joined
    assert "--pids-limit" in cmd and "--memory" in cmd and "--cpus" in cmd
    # Only the worktree is mounted (forward-slashed for Docker Desktop), plus creds ro.
    assert "C:/work/wt/task-1:/workspace" in cmd
    assert any(a.endswith(f"{sandbox.CREDS_TARGET}:ro") for a in cmd)
    # Egress goes through the internal network + allow-list proxy, never direct.
    assert sandbox.NET_INTERNAL in cmd
    assert f"HTTPS_PROXY=http://{sandbox.PROXY_NAME}:{sandbox.PROXY_PORT}" in cmd


def test_wrap_strips_host_only_mcp_flags() -> None:
    # A host ragmcp knowledge base can't be reached from the box — drop it cleanly
    # (flag AND its path arg) rather than pass a broken --mcp-config into the run.
    base = ["claude", "-p", "--mcp-config", "C:/proj/.mcp.json", "--strict-mcp-config",
            "--max-turns", "6"]
    cmd = sandbox.wrap(base, Path("C:/work/wt/t"))
    assert "--mcp-config" not in cmd
    assert "C:/proj/.mcp.json" not in cmd
    assert "--strict-mcp-config" not in cmd
    assert "--max-turns" in cmd and "6" in cmd  # unrelated flags survive


def test_setup_uses_injected_runner(tmp_path: Path) -> None:
    # In sandbox mode the dispatcher injects a box runner; here a fake proves the
    # commands are handed to the runner (in order) rather than the host path.
    calls: list[str] = []
    def fake(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
        calls.append(cmd)
        return (0, "")
    worktree.run_setup(tmp_path, ("uv sync", "npm ci"), 60, fake)
    assert calls == ["uv sync", "npm ci"]


def test_setup_runner_failure_raises_setup_error(tmp_path: Path) -> None:
    def fake(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
        return (1, "could not resolve dependency\nboom")
    with pytest.raises(worktree.SetupError):
        worktree.run_setup(tmp_path, ("uv sync",), 60, fake)
