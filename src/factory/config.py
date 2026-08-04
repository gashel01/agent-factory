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


# Claude Code reasoning-effort levels, from cheapest/fastest to deepest. The CLI
# is the source of truth; we validate here only to fail with a clear message
# instead of a cryptic subprocess error.
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max", "ultracode")


@dataclass(frozen=True)
class AgentConfig:
    command: tuple[str, ...] = ("claude",)
    model: str | None = None
    permission_mode: str = "acceptEdits"
    allowed_tools: tuple[str, ...] = DEFAULT_ALLOWED_TOOLS
    extra_args: tuple[str, ...] = ()
    effort: str | None = None  # --effort <level>; None = the CLI's own default
    mcp_config: str | None = None  # path to an .mcp.json (e.g. the project knowledge base)


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
class IntegrationConfig:
    """Post-run check: once every ticket has merged, run the full suite ONCE on
    the integration branch. Per-ticket verify proves each change in isolation;
    this proves they still hold together. Off (no commands) by default."""

    commands: tuple[str, ...] = ()
    command_timeout_s: int = 1200


#: Supervisor defaults: read anything, act only through the operator channels
#: (control.jsonl appends, ticket edits). Extend via supervisor.allowed_tools —
#: e.g. add "WebSearch" or MCP tools ("mcp__github__*") declared in a .mcp.json
#: placed in the workspace.
DEFAULT_SUPERVISOR_TOOLS = ("Read", "Glob", "Grep", "Write", "Edit")


@dataclass(frozen=True)
class SupervisorConfig:
    allowed_tools: tuple[str, ...] = DEFAULT_SUPERVISOR_TOOLS
    # The supervisor reads run state and answers the operator — a job a cheap tier
    # handles well, especially now that a live run snapshot is fed to it (it rarely
    # needs deep tool exploration). Defaulting to a cheap model keeps the chat fast
    # and stops it from drawing the run's expensive coding-model quota. Override to
    # match the coding agents by setting supervisor.model to "" or a specific model.
    model: str | None = "haiku"
    timeout_min: int = 10


@dataclass(frozen=True)
class PlanConfig:
    # The planner explores the repo once and can run on a cheaper tier than the
    # coding agents. None = fall back to agent.model.
    model: str | None = None


@dataclass(frozen=True)
class PrConfig:
    """PR-native mode: instead of merging a verified ticket into the local base,
    push its branch and open a GitHub PR (via `gh`). Off by default. Needs a
    GitHub remote and an authenticated `gh` CLI."""

    enabled: bool = False


@dataclass(frozen=True)
class NotifyConfig:
    """External notifications: POST a short message to a webhook (Slack, Discord,
    or any endpoint) when a run finishes or a ticket needs a human. Off (empty
    URL) by default. So you can walk away and still get pinged."""

    webhook_url: str = ""


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
    # User parameter, no hard ceiling: 2 is a conservative default on a subscription
    # plan — every agent shares ONE plan rate-limit bucket with the operator's own
    # interactive Claude Code, so extra concurrency competes with it. Raise it when
    # you're not working alongside a run. The rate-limit handler is the safety net.
    max_slots: int = 2
    stagger_seconds: float = 20.0
    # Retries a failing ticket gets before it is marked FAILED. Low by default so a
    # task that keeps failing review does not silently burn the subscription: each
    # retry is a full agent run. A ticket can still override with its own max_retries.
    default_max_retries: int = 1
    # Cost ceiling for the whole run, in API-equivalent USD (the number the CLI
    # reports per agent). None = no cap. When cumulative spend crosses it, no new
    # agents launch; in-flight ones finish. A visible, adjustable safety net.
    budget_usd: float | None = None
    # Control mode: when on, a task that passes verify (and review) does NOT merge
    # automatically — it parks in AWAITING_APPROVAL until the operator approves it
    # from the dashboard. Off by default (fully autonomous).
    manual_approval: bool = False
    # Execution mode: "subscription" (strip ANTHROPIC_API_KEY, draw from the plan —
    # no real charge) or "api" (inherit the key, real dollars). Subscription-first
    # by default so a run never bills by surprise.
    execution_mode: str = "subscription"
    # Isolation: "direct" (agent runs as a host subprocess in its worktree — fast,
    # full capability, the default) or "sandbox" (agent runs inside a hardened
    # Docker container: only its worktree is visible, egress is allow-listed to
    # Anthropic, privileges dropped). "direct" by default so the everyday flow stays
    # fast; "sandbox" is opt-in for untrusted contexts. See factory/sandbox.py.
    isolation: str = "direct"
    pr: PrConfig = field(default_factory=PrConfig)
    contract_path: Path | None = None
    agent: AgentConfig = field(default_factory=AgentConfig)
    setup: SetupConfig = field(default_factory=SetupConfig)
    verify: VerifyConfig = field(default_factory=VerifyConfig)
    integration: IntegrationConfig = field(default_factory=IntegrationConfig)
    plan: PlanConfig = field(default_factory=PlanConfig)
    review: ReviewConfig = field(default_factory=ReviewConfig)
    supervisor: SupervisorConfig = field(default_factory=SupervisorConfig)
    ratelimit: RateLimitConfig = field(default_factory=RateLimitConfig)
    notify: NotifyConfig = field(default_factory=NotifyConfig)

    def with_overrides(self, *, max_slots: int | None = None) -> Config:
        return replace(self, max_slots=max_slots) if max_slots else self


def _validate_effort(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text not in EFFORT_LEVELS:
        raise ConfigError(
            f"agent.effort must be one of {', '.join(EFFORT_LEVELS)}, got {value!r}"
        )
    return text


def _cfg_int(value: object, default: int, field: str) -> int:
    """Coerce a config field to int, or fail with an actionable ConfigError
    instead of letting a raw ValueError escape the CLI's error handler."""
    try:
        return int(value if value not in (None, "") else default)
    except (TypeError, ValueError):
        raise ConfigError(f"{field} must be a whole number, got {value!r}") from None


def _cfg_float(value: object, default: float, field: str) -> float:
    try:
        return float(value if value not in (None, "") else default)
    except (TypeError, ValueError):
        raise ConfigError(f"{field} must be a number, got {value!r}") from None


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
    budget = raw.get("budget", {}) or {}
    approval = raw.get("approval", {}) or {}
    execution = raw.get("execution", {}) or {}
    pr = raw.get("pr", {}) or {}
    agent = raw.get("agent", {}) or {}
    setup = raw.get("setup", {}) or {}
    verify = raw.get("verify", {}) or {}
    integration = raw.get("integration", {}) or {}
    plan = raw.get("plan", {}) or {}
    review = raw.get("review", {}) or {}
    supervisor = raw.get("supervisor", {}) or {}
    rate = raw.get("ratelimit", {}) or {}
    notify = raw.get("notify", {}) or {}

    contract = raw.get("contract_path")
    return Config(
        base_branch=str(repo.get("base_branch", "main")),
        max_slots=_cfg_int(conc.get("max_slots"), 2, "concurrency.max_slots"),
        stagger_seconds=_cfg_float(
            conc.get("stagger_seconds"), 20.0, "concurrency.stagger_seconds"
        ),
        default_max_retries=_cfg_int(conc.get("max_retries"), 1, "concurrency.max_retries"),
        budget_usd=(
            _cfg_float(budget["max_usd"], 0.0, "budget.max_usd")
            if budget.get("max_usd") not in (None, "")
            else None
        ),
        manual_approval=bool(approval.get("manual", False)),
        execution_mode=(
            "api" if str(execution.get("mode", "")).lower() == "api" else "subscription"
        ),
        isolation=(
            "sandbox" if str(execution.get("isolation", "")).lower() == "sandbox" else "direct"
        ),
        pr=PrConfig(enabled=bool(pr.get("enabled", False))),
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
            effort=_validate_effort(agent.get("effort")),
            mcp_config=agent.get("mcp_config"),
        ),
        setup=SetupConfig(
            commands=_as_str_tuple(setup.get("commands"), "setup.commands"),
            timeout_s=_cfg_int(setup.get("timeout_s"), 600, "setup.timeout_s"),
        ),
        verify=VerifyConfig(
            commands=_as_str_tuple(verify.get("commands"), "verify.commands"),
            command_timeout_s=_cfg_int(
                verify.get("command_timeout_s"), 600, "verify.command_timeout_s"
            ),
        ),
        integration=IntegrationConfig(
            commands=_as_str_tuple(integration.get("commands"), "integration.commands"),
            command_timeout_s=_cfg_int(
                integration.get("command_timeout_s"), 1200, "integration.command_timeout_s"
            ),
        ),
        plan=PlanConfig(model=plan.get("model")),
        review=ReviewConfig(
            enabled=bool(review.get("enabled", False)),
            model=review.get("model"),
            timeout_min=_cfg_int(review.get("timeout_min"), 10, "review.timeout_min"),
        ),
        supervisor=SupervisorConfig(
            allowed_tools=(
                _as_str_tuple(supervisor["allowed_tools"], "supervisor.allowed_tools")
                if "allowed_tools" in supervisor
                else DEFAULT_SUPERVISOR_TOOLS
            ),
            # Absent or null → cheap default (see SupervisorConfig.model). An
            # explicit "" means "same as the coding agents"; an id pins that model.
            model=(
                (supervisor.get("model") if supervisor.get("model") is not None else "haiku")
                or None
            ),
            timeout_min=_cfg_int(supervisor.get("timeout_min"), 10, "supervisor.timeout_min"),
        ),
        ratelimit=RateLimitConfig(
            cooldown_min=_cfg_int(rate.get("cooldown_min"), 20, "ratelimit.cooldown_min"),
            max_pauses_before_stop=_cfg_int(
                rate.get("max_pauses_before_stop"), 6, "ratelimit.max_pauses_before_stop"
            ),
        ),
        notify=NotifyConfig(webhook_url=str(notify.get("webhook") or "").strip()),
    )
