"""Spawn one headless Claude Code agent per task and parse its stream-json output.

The prompt is written to stdin (not argv) so ticket size is never limited by the
OS argument-length ceiling. Works with subscription auth out of the box: whatever
`claude` is logged in as is what the factory uses — no API key required.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .config import AgentConfig
from .task import Task

RATE_LIMIT_RE = re.compile(r"rate.?limit|usage limit|overloaded|too many requests|\b429\b", re.I)


def is_rate_limit_result(record: dict) -> bool:
    """Structured rate-limit detection on the final result record ONLY.

    Never regex-scan raw stream lines: the CLI's init record ALWAYS contains
    `rate_limit_info` fields (so raw scanning flags every run), and base64
    thinking signatures can contain '429' by chance. Both observed live on
    2026-07-11: two successful agents were discarded as rate-limited.
    stderr, being plain text, is still scanned.
    """
    if record.get("api_error_status") == 429:
        return True
    return bool(record.get("is_error")) and bool(
        RATE_LIMIT_RE.search(str(record.get("result", "")))
    )

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


@dataclass(frozen=True)
class StreamOutcome:
    """Raw outcome of one headless CLI invocation (shared by all agent kinds)."""

    returncode: int | None
    result: dict | None  # the stream-json "result" record, if any
    stderr_rate_limited: bool
    stderr_tail: str
    wall_s: float


async def stream_headless(
    cmd: list[str],
    prompt: str,
    cwd: Path,
    log_path: Path,
    timeout_s: float,
) -> StreamOutcome:
    """Spawn one headless agent: prompt on stdin, stream-json on stdout.

    Raises TimeoutError (budget) or CancelledError (operator kill) — the
    subprocess is reaped in both cases. Used by the coding agent, the planner,
    and the reviewer, so process handling has exactly one implementation.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result_record: dict | None = None
    stderr_limited = False
    stderr_tail: list[str] = []

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    with log_path.open("w", encoding="utf-8", errors="replace") as log:

        async def feed_stdin() -> None:
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        async def read_stdout() -> None:
            nonlocal result_record
            assert proc.stdout is not None
            while line := await proc.stdout.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(text)
                try:
                    record = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("type") == "result":
                    result_record = record

        async def read_stderr() -> None:
            nonlocal stderr_limited
            assert proc.stderr is not None
            while line := await proc.stderr.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(f"[stderr] {text}")
                stderr_tail.append(text.strip())
                del stderr_tail[:-5]
                if RATE_LIMIT_RE.search(text):
                    stderr_limited = True

        try:
            async with asyncio.timeout(timeout_s):
                await asyncio.gather(feed_stdin(), read_stdout(), read_stderr())
                await proc.wait()
        except (TimeoutError, asyncio.CancelledError):
            proc.kill()
            await proc.wait()
            raise

    return StreamOutcome(
        returncode=proc.returncode,
        result=result_record,
        stderr_rate_limited=stderr_limited,
        stderr_tail="; ".join(stderr_tail),
        wall_s=time.monotonic() - started,
    )


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
    # Resolve through PATH (and PATHEXT on Windows): a bare "claude" is often a
    # .cmd/.exe shim that CreateProcess won't find without its full path.
    exe = shutil.which(cfg.command[0])
    if exe is None:
        raise FileNotFoundError(
            f"agent command '{cfg.command[0]}' not found on PATH — "
            f"is the CLI installed and the shell environment inherited?"
        )
    cmd = [
        exe,
        *cfg.command[1:],
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
    try:
        out = await stream_headless(
            build_command(cfg, task), prompt, worktree_path, log_path,
            timeout_s=task.budget.timeout_min * 60,
        )
    except TimeoutError:
        return AgentResult(
            status="timeout",
            summary=f"killed after {task.budget.timeout_min} min budget",
            turns=None,
            wall_s=task.budget.timeout_min * 60,
            contract=None,
        )

    turns = out.result.get("num_turns") if out.result else None
    rate_limited = out.stderr_rate_limited or (
        out.result is not None and is_rate_limit_result(out.result)
    )
    if rate_limited:
        return AgentResult("ratelimit", "provider rate/usage limit hit", turns, out.wall_s, None)
    if out.returncode != 0 or out.result is None:
        summary = out.stderr_tail or f"agent exited {out.returncode} without a result"
        return AgentResult("error", summary[:500], turns, out.wall_s, None)

    contract_json = extract_trailing_json(str(out.result.get("result", "")))
    if contract_json is None:
        # No contract block (crash mid-answer, model drift): let the verify gate decide.
        return AgentResult("done", "no contract JSON in final message", turns, out.wall_s, None)
    status = str(contract_json.get("status", "done"))
    summary = str(contract_json.get("summary", ""))[:500]
    if status not in ("done", "blocked"):
        status = "done"
    return AgentResult(status, summary, turns, out.wall_s, contract_json)
