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


def test_non_numeric_config_field_raises_actionable_error(tmp_path):
    # A non-numeric numeric field must fail with a named ConfigError, not a raw
    # ValueError that escapes the CLI handler as a traceback.
    with pytest.raises(ConfigError, match="concurrency.max_slots must be a whole number"):
        _write_config(tmp_path, "concurrency:\n  max_slots: many\n")
    with pytest.raises(ConfigError, match="budget.max_usd must be a number"):
        _write_config(tmp_path, "budget:\n  max_usd: cheap\n")


def test_build_command_includes_effort_flag(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    task = load_backlog(backlog, "main")[0]

    # command=("python",) so PATH resolution succeeds on CI, where the real
    # `claude` CLI isn't installed; the argv flags under test don't depend on it.
    with_effort = build_command(AgentConfig(command=("python",), effort="xhigh"), task)
    assert "--effort" in with_effort
    assert with_effort[with_effort.index("--effort") + 1] == "xhigh"

    # No effort configured → the flag is absent (the CLI keeps its own default).
    assert "--effort" not in build_command(AgentConfig(command=("python",)), task)


def test_build_command_denies_destructive_git(tmp_path, repo):
    # A hard safety floor: every agent invocation forbids history-rewriting git ops
    # at the CLI permission layer, so a `git reset --hard` can never run inside a turn.
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    task = load_backlog(backlog, "main")[0]

    cmd = build_command(AgentConfig(command=("python",)), task)
    assert "--disallowedTools" in cmd
    denied = cmd[cmd.index("--disallowedTools") + 1]
    assert "Bash(git reset --hard:*)" in denied
    assert "Bash(git push --force:*)" in denied
    assert "Bash(git rebase:*)" in denied


def test_default_max_retries_applies_to_tickets(tmp_path, repo):
    from factory.task import load_backlog

    cfg = _write_config(tmp_path, "concurrency:\n  max_retries: 0\n")
    assert cfg.default_max_retries == 0

    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)  # no per-ticket max_retries
    task = load_backlog(backlog, "main", cfg.default_max_retries)[0]
    assert task.max_retries == 0
