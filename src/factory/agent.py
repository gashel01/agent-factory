"""Spawn one headless Claude Code agent per task and parse its stream-json output.

The prompt is written to stdin (not argv) so ticket size is never limited by the
OS argument-length ceiling. Works with subscription auth out of the box: whatever
`claude` is logged in as is what the factory uses — no API key required.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import sandbox
from .config import AgentConfig
from .task import Task

RATE_LIMIT_RE = re.compile(r"rate.?limit|usage limit|overloaded|too many requests|\b429\b", re.I)

# stream-json is newline-delimited, but a single record can carry a whole file's
# contents (a Write tool call, a Read result) — a task emitting inline SVG charts
# produces lines far past asyncio's default 64 KiB readline buffer, which then
# raises "Separator is found, but chunk is longer than limit" and kills the task.
# 64 MiB is a ceiling, not an allocation: only the actual line is held in memory.
_STREAM_LIMIT = 64 * 1024 * 1024


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
- If the ticket's change already exists in the repo (nothing left to do, `git status`
  clean, no new commit to make), that is a VALID outcome: report status "done" AND set
  "noop": true, with a summary saying it was already implemented. Do not invent a change
  to have something to commit, and never manufacture a commit.
- Never run destructive or history-rewriting git commands (`git reset --hard`,
  `git rebase`, `git push --force`, `git clean`, `git checkout -- …`). They are blocked
  at the tool layer and will fail. If one seems necessary to finish, STOP and report
  status "blocked" explaining exactly why — a human will decide and act.
- End your final message with a strict JSON block (no markdown fences around it):
  {"status": "done" | "blocked", "summary": "<one sentence>", "tests": "pass" | "fail",
   "noop": <true ONLY if the ticket needed no change; omit or false otherwise>}
- If you are blocked (missing information, a product decision), use status "blocked"
  and ask a precise question in "summary". Do not guess.
"""


@dataclass(frozen=True)
class Usage:
    """What one agent consumed, read from the CLI's final result record.

    cost_usd is the API-equivalent estimate the CLI reports even on subscription
    auth — a useful budget proxy, not a real charge. Token counts are actual.
    """

    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0


def extract_usage(record: dict | None) -> Usage:
    if not record:
        return Usage()
    u = record.get("usage") or {}
    return Usage(
        cost_usd=float(record.get("total_cost_usd") or 0.0),
        input_tokens=int(u.get("input_tokens") or 0),
        output_tokens=int(u.get("output_tokens") or 0),
        cache_read_tokens=int(u.get("cache_read_input_tokens") or 0),
    )


@dataclass(frozen=True)
class AgentResult:
    status: str  # done | blocked | error | timeout | ratelimit
    summary: str
    turns: int | None
    wall_s: float
    contract: dict | None
    session_id: str | None = None  # enables resume (answer blocked agents, redirects)
    usage: Usage = field(default_factory=Usage)
    # The agent explicitly declared the ticket needed no change (already implemented).
    # Only an explicit claim is trusted as a no-op — a plain done with no commit is a
    # broken agent, caught by the verify gate ("no commits on the task branch").
    noop: bool = False
    # Plan rate-limit snapshot (subscription): {status, resetsAt, rateLimitType, ...}
    rate_limit_info: dict | None = None


@dataclass(frozen=True)
class StreamOutcome:
    """Raw outcome of one headless CLI invocation (shared by all agent kinds)."""

    returncode: int | None
    result: dict | None  # the stream-json "result" record, if any
    stderr_rate_limited: bool
    stderr_tail: str
    wall_s: float
    # Latest plan-window info the CLI streamed (rate_limit_event), if any.
    rate_limit_info: dict | None = None


def _record_tokens(record: dict) -> int:
    """Tokens billed for one assistant turn (input + output). Cache reads are not
    added — they are the cheap part and would inflate the live counter."""
    usage = (record.get("message") or {}).get("usage") or {}
    return int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)


def describe_step(record: dict) -> str | None:
    """A short, human-readable line describing what an agent did this turn, from
    one stream-json ``assistant`` record. Prefers the tool it reached for (which
    file it read, what it searched); falls back to the first line of narration.

    Returns None when the record carries nothing worth showing (e.g. an empty
    turn), so callers can skip it. Kept dependency-free — the dashboard shows
    these lines as a live activity feed while the planner explores the repo.
    """
    content = (record.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    narration: str | None = None
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use":
            name = str(block.get("name", ""))
            inp = block.get("input") if isinstance(block.get("input"), dict) else {}
            if name == "Read":
                target = str(inp.get("file_path") or inp.get("path") or "").replace("\\", "/")
                if not target:
                    return "reading a file"
                return f"reading {target.rsplit('/', 1)[-1] or target}"
            if name == "Glob":
                return f"finding files matching {inp.get('pattern', '…')}"
            if name == "Grep":
                return f'searching for "{inp.get("pattern", "…")}"'
            return f"{name.lower()}…" if name else None
        if block.get("type") == "text" and narration is None:
            text = str(block.get("text", "")).strip()
            if text:
                first = text.splitlines()[0].strip()
                narration = first[:100] + ("…" if len(first) > 100 else "")
    return narration


def spawn_env(mode: str) -> dict[str, str] | None:
    """The environment for a spawned agent, per execution mode.

    "subscription" strips ANTHROPIC_API_KEY so the CLI falls back to the logged-in
    subscription (no real charge, draws from the plan). "api" inherits the parent
    environment unchanged (env=None), so a key already present is used and billed.
    We never read, store, or transmit the key value — only whether to pass it.
    """
    if mode == "api":
        return None
    return {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}


async def stream_headless(
    cmd: list[str],
    prompt: str,
    cwd: Path,
    log_path: Path,
    timeout_s: float,
    on_progress: Callable[[int, int], None] | None = None,
    on_activity: Callable[[dict], None] | None = None,
    env: dict[str, str] | None = None,
) -> StreamOutcome:
    """Spawn one headless agent: prompt on stdin, stream-json on stdout.

    Raises TimeoutError (budget) or CancelledError (operator kill) — the
    subprocess is reaped in both cases. Used by the coding agent, the planner,
    and the reviewer, so process handling has exactly one implementation.

    ``env`` is the child environment (None = inherit the parent's). Callers build
    it with spawn_env(mode) to control subscription vs API execution.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result_record: dict | None = None
    rate_limit_info: dict | None = None
    stderr_limited = False
    stderr_tail: list[str] = []

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=_STREAM_LIMIT,  # big stream-json records (inline SVG, file writes)
        env=env,
    )

    with log_path.open("w", encoding="utf-8", errors="replace") as log:

        async def feed_stdin() -> None:
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        async def read_stdout() -> None:
            nonlocal result_record, rate_limit_info
            assert proc.stdout is not None
            turns = 0
            tokens = 0
            while line := await proc.stdout.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(text)
                try:
                    record = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                # The CLI streams the plan-window state (5h/weekly reset, status) —
                # keep the latest so the dashboard can show plan usage on a subscription.
                if isinstance(record.get("rate_limit_info"), dict):
                    rate_limit_info = record["rate_limit_info"]
                if record.get("type") == "result":
                    result_record = record
                elif record.get("type") == "assistant":
                    # Report live progress as the agent works, so the dashboard can
                    # show a growing turn/token count instead of nothing until the end.
                    turns += 1
                    tokens += _record_tokens(record)
                    if on_progress is not None:
                        on_progress(turns, tokens)
                    if on_activity is not None:
                        on_activity(record)

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
        rate_limit_info=rate_limit_info,
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


def build_cli(
    command: tuple[str, ...],
    *,
    max_turns: int,
    allowed_tools: tuple[str, ...],
    model: str | None = None,
    effort: str | None = None,
    permission_mode: str | None = None,
    resume: str | None = None,
    mcp_config: str | None = None,
    disallowed_tools: tuple[str, ...] = (),
    extra_args: tuple[str, ...] = (),
    checkpoints: bool = False,
    missing: Callable[[str], Exception] | None = None,
) -> list[str]:
    """The shared `claude -p` headless invocation used by the coding agent, the
    planner, the reviewer, the supervisor and the doctor. Each differs only in
    turn budget, tool allowlist and model — everything else (stream-json, verbose,
    PATH resolution) is identical, so it lives here once.

    `missing` builds the exception raised when the CLI isn't on PATH, so each
    caller keeps its own typed error; the default is FileNotFoundError.
    """
    # Resolve through PATH (and PATHEXT on Windows): a bare "claude" is often a
    # .cmd/.exe shim that CreateProcess won't find without its full path.
    exe = shutil.which(command[0])
    if exe is None:
        msg = f"agent command '{command[0]}' not found on PATH"
        raise (missing(msg) if missing else FileNotFoundError(
            f"{msg} — is the CLI installed and the shell environment inherited?"
        ))
    cmd = [exe, *command[1:], "-p", "--output-format", "stream-json", "--verbose"]
    if permission_mode:
        cmd += ["--permission-mode", permission_mode]
    cmd += ["--max-turns", str(max_turns)]
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    if resume:
        cmd += ["--resume", resume]
    if mcp_config:
        # Give the agent the project's knowledge base as an MCP server (ragmcp),
        # and ONLY that one — --strict-mcp-config ignores any ambient .mcp.json in
        # the cwd so the run is reproducible. The tools it exposes still have to be
        # in --allowedTools (the caller adds them); see build_command.
        cmd += ["--mcp-config", mcp_config, "--strict-mcp-config"]
    if allowed_tools:
        cmd += ["--allowedTools", ",".join(allowed_tools)]
    if disallowed_tools:
        # A hard safety floor: even a resumed, operator-answered agent cannot run
        # these. A denied call surfaces to the agent, which (per the contract)
        # reports blocked instead of finding a workaround.
        cmd += ["--disallowedTools", ",".join(disallowed_tools)]
    if checkpoints:
        # A PostToolUse hook commits the worktree after each file edit, so the
        # dashboard can undo a single step. The hook shells out to `factory
        # checkpoint` with the SAME interpreter running this process (quoted for
        # paths with spaces), which reads the tool payload on stdin and commits cwd.
        py = sys.executable or "python"
        hook = json.dumps({
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Write|Edit|MultiEdit|NotebookEdit",
                    "hooks": [{"type": "command", "command": f'"{py}" -m factory checkpoint'}],
                }],
            },
        })
        cmd += ["--settings", hook]
    cmd += list(extra_args)
    return cmd


# The ragmcp retrieval tools the agent may call when a project knowledge base is
# wired in. Auto-added to the allowlist so enabling a knowledge base is one setting,
# not two (the mcp-config AND remembering to permit its tools).
KNOWLEDGE_TOOLS = ("mcp__ragmcp__search_documents", "mcp__ragmcp__list_sources")

# Destructive / history-rewriting git operations an agent must NEVER run itself:
# a bad `reset --hard` target eats sibling commits, `rebase`/`push --force` rewrite
# shared history, `clean`/`checkout --` wipe the tree. Denied at the CLI permission
# layer (a hard safety floor, not a per-project setting) so the only path for a
# genuinely necessary destructive step is: agent reports blocked → a human acts.
# The pattern is a command PREFIX: "git reset --hard 059d7a9" matches "git reset --hard".
DESTRUCTIVE_GIT_DENY = (
    "Bash(git reset --hard:*)",
    "Bash(git reset --keep:*)",
    "Bash(git reset --merge:*)",
    "Bash(git push --force:*)",
    "Bash(git push -f:*)",
    "Bash(git push --force-with-lease:*)",
    "Bash(git rebase:*)",
    "Bash(git clean:*)",
    "Bash(git checkout --:*)",
    "Bash(git checkout .:*)",
    "Bash(git branch -D:*)",
    "Bash(git branch -d:*)",
    "Bash(git filter-branch:*)",
    "Bash(git update-ref -d:*)",
)


def build_command(cfg: AgentConfig, task: Task) -> list[str]:
    # A ticket may pin its own model and effort (cheap tier for a trivial change,
    # a stronger/deeper one for a hard task) and, on a retry, resume its previous
    # session (context + repo knowledge intact) — all overriding the run defaults.
    allowed = cfg.allowed_tools
    if cfg.mcp_config:
        allowed = (*allowed, *KNOWLEDGE_TOOLS)
    return build_cli(
        cfg.command,
        max_turns=task.budget.max_turns,
        allowed_tools=allowed,
        model=task.model or cfg.model,
        effort=task.effort or cfg.effort,
        permission_mode=cfg.permission_mode,
        resume=task.resume_session,
        mcp_config=cfg.mcp_config,
        disallowed_tools=DESTRUCTIVE_GIT_DENY,
        extra_args=cfg.extra_args,
        checkpoints=cfg.checkpoints,
    )


async def run_agent(
    cfg: AgentConfig,
    task: Task,
    worktree_path: Path,
    contract: str,
    log_path: Path,
    lessons: str = "",
    project_brief: str = "",
    on_progress: Callable[[int, int], None] | None = None,
    mode: str = "subscription",
    isolation: str = "direct",
) -> AgentResult:
    if task.resume_session:
        # Resumed retry: the session already carries the contract, ticket, brief
        # and repo knowledge — only the corrective feedback is new information.
        latest = task.failure_notes[-1] if task.failure_notes else "the attempt did not pass"
        prompt = (
            "Your previous attempt on this ticket did not pass.\n"
            f"Feedback: {latest}\n"
            "Your worktree is untouched — your files and commits are still here. "
            "Fix the problem, re-run the success criteria, and finish the ticket "
            "contract as before (commit your changes, end with the JSON block).\n"
        )
    else:
        prompt = f"{contract}\n"
        if project_brief:
            # A shared map of the repo (from planning): the agent reads this instead
            # of rediscovering the project's layout and conventions on every ticket.
            prompt += f"\n---\n\n# Project map (read before exploring)\n\n{project_brief}\n"
        prompt += f"\n---\n\n# Ticket\n\n{task.render()}\n"
        if lessons:
            # Lessons recalled from earlier work: rules the operator recorded so a
            # past mistake is not repeated. They come after the ticket so the agent
            # reads the task first, then the constraints that apply to it.
            prompt += (
                "\n---\n\n# Lessons from earlier work (apply these before you start)\n\n"
                f"{lessons}\n"
            )
    cmd = build_command(cfg, task)
    env = spawn_env(mode)
    if isolation == "sandbox":
        # Wrap the SAME claude invocation in a hardened container. The box
        # authenticates via the mounted OAuth token, so we never inject the API
        # key into it (env=None) — even in "api" execution mode, the sandbox draws
        # on the logged-in subscription rather than putting a key where the agent's
        # own python could read and exfiltrate it.
        try:
            await asyncio.to_thread(sandbox.ensure_infra)
        except sandbox.SandboxError as exc:
            return AgentResult("error", f"sandbox unavailable: {exc}"[:500],
                               None, 0.0, None)
        cmd = sandbox.wrap(cmd, worktree_path)
        env = None
    try:
        out = await stream_headless(
            cmd, prompt, worktree_path, log_path,
            timeout_s=task.budget.timeout_min * 60,
            on_progress=on_progress,
            env=env,
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
    raw_session = out.result.get("session_id") if out.result else None
    session = str(raw_session) if raw_session else None
    usage = extract_usage(out.result)
    rate_limited = out.stderr_rate_limited or (
        out.result is not None and is_rate_limit_result(out.result)
    )
    rli = out.rate_limit_info
    if rate_limited:
        return AgentResult(
            "ratelimit", "provider rate/usage limit hit", turns, out.wall_s, None, session, usage,
            rate_limit_info=rli,
        )
    if out.returncode != 0 or out.result is None:
        summary = out.stderr_tail or f"agent exited {out.returncode} without a result"
        return AgentResult(
            "error", summary[:500], turns, out.wall_s, None, session, usage, rate_limit_info=rli
        )

    contract_json = extract_trailing_json(str(out.result.get("result", "")))
    if contract_json is None:
        # No contract block (crash mid-answer, model drift): let the verify gate decide.
        return AgentResult(
            "done", "no contract JSON in final message", turns, out.wall_s, None, session, usage,
            rate_limit_info=rli,
        )
    status = str(contract_json.get("status", "done"))
    summary = str(contract_json.get("summary", ""))[:500]
    if status not in ("done", "blocked"):
        status = "done"
    noop = status == "done" and bool(contract_json.get("noop"))
    return AgentResult(
        status, summary, turns, out.wall_s, contract_json, session, usage,
        noop=noop, rate_limit_info=rli,
    )
