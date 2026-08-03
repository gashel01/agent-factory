"""Adversarial review gate: a second agent tries to REJECT the diff.

The deterministic verify gate catches what breaks; the reviewer catches what
cheats — scope creep, weakened assertions, success criteria gamed. It runs
read-only inside the worktree, judges the diff against the ticket, and a
rejection sends the task back to the queue with the reasons as evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .agent import (
    build_cli,
    extract_trailing_json,
    is_rate_limit_result,
    spawn_env,
    stream_headless,
)
from .config import Config
from .task import Task
from .worktree import git

#: Judgement only — the reviewer must not be able to modify anything.
REVIEWER_TOOLS = ("Read", "Glob", "Grep")

#: Diffs beyond this are truncated; the reviewer can Read files for the rest.
MAX_DIFF_CHARS = 60_000

REVIEW_CONTRACT = """\
# Review contract — Agent Factory (adversarial)

You are a REVIEW agent. Another agent produced the diff below for the ticket
below. Your job is to find reasons to REJECT it. You are read-only: you may
Read/Glob/Grep the repository to check context, but you change nothing.

Reject if — and only if — one of these holds:
1. The diff does not actually do what the ticket asks.
2. Scope creep: files or behaviour changed that the ticket did not ask for
   (check the ticket's "Out of scope" section).
3. An obvious bug a careful reader can spot (logic error, broken edge case).
4. The success criteria were gamed: tests weakened or deleted, assertions
   loosened, verification circumvented instead of satisfied.

Style preferences, naming taste, or "I would have done it differently" are
NOT reject reasons. When genuinely uncertain, approve — the deterministic
test gate already passed.

End your final message with a strict JSON block (no fences):
{"status": "done", "verdict": "approve" | "reject", "reasons": ["<short, specific>"]}
"""


class ReviewError(Exception):
    """Reviewer infrastructure failed (not a rejection)."""


@dataclass(frozen=True)
class ReviewResult:
    verdict: str  # approve | reject
    reasons: tuple[str, ...]
    rate_limited: bool = False


def build_review_prompt(task: Task, worktree_path: Path) -> str:
    diff = git(worktree_path, "diff", f"{task.base_branch}..HEAD").stdout
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n[... diff truncated — Read the files for the rest]"
    return (
        f"{REVIEW_CONTRACT}\n\n---\n\n# Ticket\n\n{task.render()}\n\n"
        f"---\n\n# Diff under review ({task.base_branch}..HEAD)\n\n```diff\n{diff}\n```\n"
    )


async def run_review(cfg: Config, task: Task, worktree_path: Path, log_path: Path) -> ReviewResult:
    cmd = build_cli(
        cfg.agent.command,
        max_turns=25,
        allowed_tools=REVIEWER_TOOLS,
        model=cfg.review.model or cfg.agent.model,
        missing=ReviewError,
    )

    prompt = build_review_prompt(task, worktree_path)
    try:
        out = await stream_headless(
            cmd, prompt, worktree_path, log_path, timeout_s=cfg.review.timeout_min * 60,
            env=spawn_env(cfg.execution_mode),
        )
    except TimeoutError:
        # A silent reviewer must not block good work forever: fail open with a
        # trace, the deterministic gate already passed.
        return ReviewResult("approve", (f"review skipped: exceeded {cfg.review.timeout_min} min",))

    if out.stderr_rate_limited or (out.result is not None and is_rate_limit_result(out.result)):
        return ReviewResult("approve", (), rate_limited=True)
    if out.returncode != 0 or out.result is None:
        raise ReviewError(out.stderr_tail or f"reviewer exited {out.returncode} without a result")

    contract = extract_trailing_json(str(out.result.get("result", "")))
    if contract is None or contract.get("verdict") not in ("approve", "reject"):
        # An unparseable review is infrastructure noise, not a judgement.
        return ReviewResult("approve", ("review skipped: no parseable verdict",))
    reasons = tuple(str(r) for r in contract.get("reasons", []))[:8]
    return ReviewResult(str(contract["verdict"]), reasons)
