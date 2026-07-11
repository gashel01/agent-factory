"""Spawn one headless Claude Code agent per task and parse its stream-json output.

The prompt is written to stdin (not argv) so ticket size is never limited by the
OS argument-length ceiling. Works with subscription auth out of the box: whatever
`claude` is logged in as is what the factory uses — no API key required.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .config import AgentConfig
from .task import Task

RATE_LIMIT_RE = re.compile(r"rate.?limit|usage limit|overloaded|too many requests|\b429\b", re.I)

DEFAULT_CONTRACT = """\
# Execution contract — Agent Factory

- You work inside an isolated git worktree, already checked out on your task branch.
  Touch nothing outside this working directory.
- Scope is the ticket below, nothing else. No opportunistic refactoring, no dependency
  upgrades that the ticket does not ask for.
- Before finishing: run the success criteria commands yourself. If they fail, fix the
  code. Never finish on a red state without explaining why.
- Commit your work with atomic commits, messages like `feat|fix|test(scope): ...`.
  Do not add any AI attribution to commits.
- End your final message with a strict JSON block (no markdown fences around it):
  {"status": "done" | "blocked", "summary": "<one sentence>", "tests": "pass" | "fail"}
- If you are blocked (missing information, a product decision), use status "blocked"
  and ask a precise question in "summary". Do not guess.
"""


@dataclass(frozen=True)
class AgentResult:
    status: str  # done | blocked | error | timeout | ratelimit
    summary: str
    turns: int | None
    wall_s: float
    contract: dict | None


def extract_trailing_json(text: str) -> dict | None:
    """Find the contract JSON at the end of the agent's final message."""
    cleaned = text.rstrip().removesuffix("```").rstrip()
    starts = [i for i, ch in enumerate(cleaned) if ch == "{"]
    for i in reversed(starts[-50:]):
        try:
            candidate = json.loads(cleaned[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "status" in candidate:
            return candidate
    return None


def build_command(cfg: AgentConfig, task: Task) -> list[str]:
    cmd = [
        *cfg.command,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",  # required by the CLI when streaming with -p
        "--permission-mode",
        cfg.permission_mode,
        "--max-turns",
        str(task.budget.max_turns),
    ]
    if cfg.model:
        cmd += ["--model", cfg.model]
    if cfg.allowed_tools:
        cmd += ["--allowedTools", ",".join(cfg.allowed_tools)]
    cmd += list(cfg.extra_args)
    return cmd


async def run_agent(
    cfg: AgentConfig,
    task: Task,
    worktree_path: Path,
    contract: str,
    log_path: Path,
) -> AgentResult:
    prompt = f"{contract}\n\n---\n\n# Ticket\n\n{task.render()}\n"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    rate_limited = False
    result_record: dict | None = None
    stderr_tail: list[str] = []

    proc = await asyncio.create_subprocess_exec(
        *build_command(cfg, task),
        cwd=str(worktree_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    with log_path.open("w", encoding="utf-8", errors="replace") as log:

        async def read_stdout() -> None:
            nonlocal rate_limited, result_record
            assert proc.stdout is not None
            while line := await proc.stdout.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(text)
                if RATE_LIMIT_RE.search(text):
                    rate_limited = True
                try:
                    record = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("type") == "result":
                    result_record = record

        async def read_stderr() -> None:
            nonlocal rate_limited
            assert proc.stderr is not None
            while line := await proc.stderr.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(f"[stderr] {text}")
                stderr_tail.append(text.strip())
                del stderr_tail[:-5]
                if RATE_LIMIT_RE.search(text):
                    rate_limited = True

        async def feed_stdin() -> None:
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        try:
            async with asyncio.timeout(task.budget.timeout_min * 60):
                await asyncio.gather(feed_stdin(), read_stdout(), read_stderr())
                await proc.wait()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return AgentResult(
                status="timeout",
                summary=f"killed after {task.budget.timeout_min} min budget",
                turns=None,
                wall_s=time.monotonic() - started,
                contract=None,
            )

    wall_s = time.monotonic() - started
    turns = result_record.get("num_turns") if result_record else None

    if rate_limited:
        return AgentResult("ratelimit", "provider rate/usage limit hit", turns, wall_s, None)
    if proc.returncode != 0 or result_record is None:
        summary = "; ".join(stderr_tail) or f"agent exited {proc.returncode} without a result"
        return AgentResult("error", summary[:500], turns, wall_s, None)

    final_text = str(result_record.get("result", ""))
    contract_json = extract_trailing_json(final_text)
    if contract_json is None:
        # No contract block (crash mid-answer, model drift): let the verify gate decide.
        return AgentResult("done", "no contract JSON in final message", turns, wall_s, None)
    status = str(contract_json.get("status", "done"))
    summary = str(contract_json.get("summary", ""))[:500]
    if status not in ("done", "blocked"):
        status = "done"
    return AgentResult(status, summary, turns, wall_s, contract_json)
