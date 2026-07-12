"""Config loading and the reasoning-effort knob."""

from __future__ import annotations

import pytest

from conftest import write_ticket
from factory.agent import build_command
from factory.config import AgentConfig, ConfigError, load_config
from factory.task import load_backlog


def _write_config(tmp_path, body: str):
    path = tmp_path / "factory.yaml"
    path.write_text(body, encoding="utf-8")
    return load_config(path)


def test_effort_is_parsed_and_normalized(tmp_path):
    cfg = _write_config(tmp_path, "agent:\n  effort: HIGH\n")
    assert cfg.agent.effort == "high"


def test_effort_defaults_to_none(tmp_path):
    cfg = _write_config(tmp_path, "agent:\n  model: opus\n")
    assert cfg.agent.effort is None


def test_invalid_effort_is_rejected(tmp_path):
    with pytest.raises(ConfigError, match="agent.effort must be one of"):
        _write_config(tmp_path, "agent:\n  effort: turbo\n")


def test_build_command_includes_effort_flag(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    task = load_backlog(backlog, "main")[0]

    with_effort = build_command(AgentConfig(effort="xhigh"), task)
    assert "--effort" in with_effort
    assert with_effort[with_effort.index("--effort") + 1] == "xhigh"

    # No effort configured → the flag is absent (the CLI keeps its own default).
    assert "--effort" not in build_command(AgentConfig(), task)
