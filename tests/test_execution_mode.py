"""Execution mode: subscription strips the API key, api inherits it."""

from __future__ import annotations

import os
from pathlib import Path
from unittest import mock

from factory.agent import spawn_env
from factory.config import load_config


def test_subscription_strips_api_key() -> None:
    with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-secret", "PATH": "/x"}, clear=True):
        env = spawn_env("subscription")
    assert env is not None
    assert "ANTHROPIC_API_KEY" not in env  # the CLI falls back to the subscription login
    assert env["PATH"] == "/x"  # the rest of the environment is preserved


def test_api_inherits_environment() -> None:
    # None means "inherit the parent env unchanged" — the key already present is used.
    assert spawn_env("api") is None


def test_config_parses_mode(tmp_path: Path) -> None:
    cfg = tmp_path / "factory.yaml"
    cfg.write_text("execution:\n  mode: api\n", encoding="utf-8")
    assert load_config(cfg).execution_mode == "api"
    # Default and any non-"api" value are subscription (never bill by surprise).
    assert load_config(None).execution_mode == "subscription"
    cfg.write_text("execution:\n  mode: subscription\n", encoding="utf-8")
    assert load_config(cfg).execution_mode == "subscription"
