"""Run configuration: factory.yaml merged over safe defaults, then CLI overrides."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

# Headless agents cannot answer permission prompts, so anything not allow-listed is
# silently denied. This default covers the contract's obligations (commit, run tests)
# without granting arbitrary shell access.
DEFAULT_ALLOWED_TOOLS = (
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(pytest:*)",
    "Bash(python:*)",
    "Bash(ruff:*)",
)


class ConfigError(Exception):
    """Raised when factory.yaml is malformed; the message is user-actionable."""


@dataclass(frozen=True)
class AgentConfig:
    command: tuple[str, ...] = ("claude",)
    model: str | None = None
    permission_mode: str = "acceptEdits"
    allowed_tools: tuple[str, ...] = DEFAULT_ALLOWED_TOOLS
    extra_args: tuple[str, ...] = ()


@dataclass(frozen=True)
class SetupConfig:
    """Commands run inside each fresh worktree BEFORE the agent starts.

    A git worktree shares no venv/node_modules with the main checkout, so real
    repos need their dependencies installed per worktree (e.g. "uv sync",
    "npm ci"). Setup failure fails the task before any tokens are spent.
    """

    commands: tuple[str, ...] = ()
    timeout_s: int = 600


@dataclass(frozen=True)
class VerifyConfig:
    commands: tuple[str, ...] = ()
    command_timeout_s: int = 600


@dataclass(frozen=True)
class ReviewConfig:
    # Off by default: it doubles per-task agent spend. Turn it on when merges
    # land somewhere that matters.
    enabled: bool = False
    model: str | None = None  # cheap tier recommended (e.g. "haiku")
    timeout_min: int = 10


@dataclass(frozen=True)
class RateLimitConfig:
    cooldown_min: int = 20
    max_pauses_before_stop: int = 6


@dataclass(frozen=True)
class Config:
    base_branch: str = "main"
    # User parameter, no hard ceiling: 3 is a sane default on a subscription plan.
    # The rate-limit handler is the actual safety net, not this number.
    max_slots: int = 3
    stagger_seconds: float = 20.0
    contract_path: Path | None = None
    agent: AgentConfig = field(default_factory=AgentConfig)
    setup: SetupConfig = field(default_factory=SetupConfig)
    verify: VerifyConfig = field(default_factory=VerifyConfig)
    review: ReviewConfig = field(default_factory=ReviewConfig)
    ratelimit: RateLimitConfig = field(default_factory=RateLimitConfig)

    def with_overrides(self, *, max_slots: int | None = None) -> Config:
        return replace(self, max_slots=max_slots) if max_slots else self


def _as_str_tuple(value: object, key: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return tuple(value)
    raise ConfigError(f"'{key}' must be a string or a list of strings, got {value!r}")


def load_config(path: Path | None) -> Config:
    """Load factory.yaml; a missing file just means defaults."""
    if path is None or not path.exists():
        return Config()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path}: invalid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top level must be a mapping")

    repo = raw.get("repo_defaults", {}) or {}
    conc = raw.get("concurrency", {}) or {}
    agent = raw.get("agent", {}) or {}
    setup = raw.get("setup", {}) or {}
    verify = raw.get("verify", {}) or {}
    review = raw.get("review", {}) or {}
    rate = raw.get("ratelimit", {}) or {}

    contract = raw.get("contract_path")
    return Config(
        base_branch=str(repo.get("base_branch", "main")),
        max_slots=int(conc.get("max_slots", 3)),
        stagger_seconds=float(conc.get("stagger_seconds", 20.0)),
        contract_path=Path(contract) if contract else None,
        agent=AgentConfig(
            command=_as_str_tuple(agent.get("command", "claude"), "agent.command"),
            model=agent.get("model"),
            permission_mode=str(agent.get("permission_mode", "acceptEdits")),
            allowed_tools=(
                _as_str_tuple(agent["allowed_tools"], "agent.allowed_tools")
                if "allowed_tools" in agent
                else DEFAULT_ALLOWED_TOOLS
            ),
            extra_args=_as_str_tuple(agent.get("extra_args"), "agent.extra_args"),
        ),
        setup=SetupConfig(
            commands=_as_str_tuple(setup.get("commands"), "setup.commands"),
            timeout_s=int(setup.get("timeout_s", 600)),
        ),
        verify=VerifyConfig(
            commands=_as_str_tuple(verify.get("commands"), "verify.commands"),
            command_timeout_s=int(verify.get("command_timeout_s", 600)),
        ),
        review=ReviewConfig(
            enabled=bool(review.get("enabled", False)),
            model=review.get("model"),
            timeout_min=int(review.get("timeout_min", 10)),
        ),
        ratelimit=RateLimitConfig(
            cooldown_min=int(rate.get("cooldown_min", 20)),
            max_pauses_before_stop=int(rate.get("max_pauses_before_stop", 6)),
        ),
    )
