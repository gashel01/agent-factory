"""The supervisor: a conversational agent that watches and steers the factory.

`factory ask "<message>"` spawns one agent inside the WORKSPACE (not a repo).
It reads the ground truth — events.jsonl, per-agent logs, backlog tickets —
and acts through the same channels the dashboard uses: appending operator
commands to control.jsonl and editing ticket files. Session continuity via
`--resume`: the supervisor remembers previous exchanges, so it is a running
conversation, not a stateless Q&A.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .agent import extract_trailing_json, is_rate_limit_result, stream_headless
from .config import Config

SUPERVISOR_CONTRACT = """\
# Supervisor contract — Agent Factory

You are the SUPERVISOR of an agent factory. The operator talks to you from a
dashboard. Your working directory is the factory WORKSPACE:

- `runs/<newest>/events.jsonl` — the run's ground truth (states, failures,
  reviews, retries, merges). The newest directory under `runs/` is the
  current run.
- `runs/<run>/agents/<task>.stdout.jsonl` — each agent's full activity log.
- `backlog/*.md` — pending tickets; `backlog/done/` — merged ones.
- `runs/<run>/control.jsonl` — APPEND-ONLY operator command channel. To act,
  append one JSON line: {"op": "pause"|"resume"|"stop"} or
  {"op": "kill"|"retry", "task": "<id>"}. The dispatcher applies it within
  a second. Never rewrite this file, only append.

Rules:
- Ground every claim in a file you actually read. Never invent task states.
- Answer the operator's question first, briefly and concretely.
- Act only when asked (or when the operator clearly wants an outcome that
  requires it): kill a runaway task, retry a failure, pause, edit or create
  a ticket in backlog/ (same format as existing tickets, quoted string ids,
  next free number). To redirect a running task: kill it, then amend its
  ticket with the new direction, then append a retry command.
- After acting, state exactly what you did (which lines appended, which
  files edited).
- You cannot talk to running agents directly; your levers are the control
  channel and the backlog. Say so if asked for something beyond them.

End your final message with a strict JSON block (no fences):
{"status": "done", "reply": "<your answer to the operator, plain language>",
 "actions": ["<one short line per action taken, empty if none>"]}
"""


class SuperviseError(Exception):
    """Supervisor infrastructure failed; message is operator-actionable."""


def _session_file(workdir: Path) -> Path:
    return workdir / ".supervisor-session"


async def ask(cfg: Config, workdir: Path, message: str, log_path: Path) -> dict:
    """One supervisor exchange; resumes the previous session when one exists."""
    exe = shutil.which(cfg.agent.command[0])
    if exe is None:
        raise SuperviseError(f"agent command '{cfg.agent.command[0]}' not found on PATH")

    cmd = [
        exe,
        *cfg.agent.command[1:],
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "30",
        "--allowedTools",
        ",".join(cfg.supervisor.allowed_tools),
    ]
    if model := (cfg.supervisor.model or cfg.agent.model):
        cmd += ["--model", model]

    session_file = _session_file(workdir)
    resumed = session_file.exists()
    if resumed:
        # Resume keeps the whole conversation: the contract is already in context.
        cmd += ["--resume", session_file.read_text(encoding="utf-8").strip()]
        prompt = f"{message}\n"
    else:
        prompt = f"{SUPERVISOR_CONTRACT}\n\n---\n\n# Operator\n\n{message}\n"

    try:
        out = await stream_headless(
            cmd, prompt, workdir, log_path, timeout_s=cfg.supervisor.timeout_min * 60
        )
    except TimeoutError as exc:
        raise SuperviseError(
            f"supervisor exceeded its {cfg.supervisor.timeout_min} min budget"
        ) from exc

    if out.stderr_rate_limited or (out.result is not None and is_rate_limit_result(out.result)):
        raise SuperviseError("rate limit hit — try again in a few minutes")
    if (out.returncode != 0 or out.result is None) and resumed:
        # The stored session may have expired: retry once, fresh.
        session_file.unlink(missing_ok=True)
        return await ask(cfg, workdir, message, log_path)
    if out.returncode != 0 or out.result is None:
        raise SuperviseError(out.stderr_tail or f"supervisor exited {out.returncode}")

    if session := out.result.get("session_id"):
        session_file.write_text(str(session), encoding="utf-8")

    contract = extract_trailing_json(str(out.result.get("result", "")))
    if contract is None or "reply" not in contract:
        # Fall back to the raw final text rather than losing the answer.
        return {"reply": str(out.result.get("result", ""))[:4000], "actions": []}
    return {
        "reply": str(contract.get("reply", "")),
        "actions": [str(a) for a in contract.get("actions", [])],
    }


def reset(workdir: Path) -> None:
    """Forget the conversation: the next ask starts a fresh supervisor session."""
    _session_file(workdir).unlink(missing_ok=True)


def format_answer(answer: dict) -> str:
    lines = [answer["reply"].strip()]
    if answer["actions"]:
        lines.append("")
        lines.extend(f"  * {action}" for action in answer["actions"])
    return "\n".join(lines)
