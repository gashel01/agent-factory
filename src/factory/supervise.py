"""The supervisor: a conversational agent that watches and steers the factory.

`factory ask "<message>"` spawns one agent inside the WORKSPACE (not a repo).
It reads the ground truth — events.jsonl, per-agent logs, backlog tickets —
and acts through the same channels the dashboard uses: appending operator
commands to control.jsonl and editing ticket files. Session continuity via
`--resume`: the supervisor remembers previous exchanges, so it is a running
conversation, not a stateless Q&A.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from .agent import (
    build_cli,
    extract_trailing_json,
    is_rate_limit_result,
    spawn_env,
    stream_headless,
)
from .config import Config
from .events import EventLog

#: Terminal task states worth surfacing at the top of a snapshot.
_ATTENTION_STATES = ("BLOCKED", "FAILED", "AWAITING_APPROVAL")


def _newest_run(runs_dir: Path) -> Path | None:
    if not runs_dir.exists():
        return None
    runs = sorted(p for p in runs_dir.glob("*") if (p / "events.jsonl").exists())
    return runs[-1] if runs else None


def run_digest(runs_dir: Path, max_recent: int = 10) -> str:
    """A compact, current snapshot of the newest run, folded from events.jsonl.

    Handed to the supervisor on EVERY message so it can answer straight away
    instead of spending turns re-tailing logs. Empty string when no run exists
    yet (the supervisor then just talks about the backlog / general questions).
    """
    run_dir = _newest_run(runs_dir)
    if run_dir is None:
        return ""

    states: dict[str, str] = {}
    summaries: dict[str, str] = {}
    recent: list[str] = []
    spend = 0.0
    started = ended = slots = stopped = None
    plan_limit: dict | None = None

    for e in EventLog.replay(run_dir / "events.jsonl"):
        ev, ts = e.get("event"), str(e.get("ts", ""))[11:16]  # HH:MM (UTC)
        if ev == "run_start":
            started, slots = ts, e.get("slots")
        elif ev == "run_end":
            ended, stopped = ts, e.get("stopped")
        elif ev == "state":
            states[str(e.get("task"))] = str(e.get("to"))
            recent.append(f"{ts} {e.get('task')} → {e.get('to')}")
        elif ev == "failure":
            summaries[str(e.get("task"))] = str(e.get("reason", ""))[:160]
        elif ev == "agent_result":
            spend = e.get("spent_usd", spend) or spend
            if e.get("summary"):
                summaries[str(e.get("task"))] = str(e.get("summary"))[:160]
        elif ev in ("stopped", "paused_ratelimit"):
            recent.append(f"{ts} {ev} {str(e.get('reason', ''))[:80]}".rstrip())
        elif ev == "plan_limit":
            plan_limit = e

    if not states and not started:
        return ""

    counts: dict[str, int] = {}
    for st in states.values():
        counts[st] = counts.get(st, 0) + 1
    counts_line = ", ".join(f"{n} {st}" for st, n in sorted(counts.items(), key=lambda kv: -kv[1]))

    status = "ENDED" if ended else "RUNNING"
    head = f"Run {run_dir.name} · {status}"
    if started:
        head += f" · started {started}"
    if slots:
        head += f" · {slots} slots"
    head += f" · spend ~${spend:.2f}"
    if stopped:
        head += f" · stopped: {stopped}"

    lines = [
        "# Live run snapshot (already read for you from events.jsonl)",
        head,
        f"States: {counts_line}" if counts_line else "States: (none yet)",
    ]

    attention = [t for t, st in states.items() if st in _ATTENTION_STATES]
    if attention:
        lines.append("Needs attention:")
        for t in sorted(attention):
            note = summaries.get(t, "")
            lines.append(f"  - {t} {states[t]}" + (f" — {note}" if note else ""))

    if recent:
        lines.append("Recent:")
        lines.extend(f"  {r}" for r in recent[-max_recent:])

    if plan_limit and plan_limit.get("status"):
        resets = plan_limit.get("resets_at") or "?"
        lines.append(f"Plan limit: {plan_limit.get('status')} (resets {resets})")

    return "\n".join(lines)

SUPERVISOR_CONTRACT = """\
# Supervisor contract — Agent Factory

You are the SUPERVISOR of an agent factory. The operator talks to you from a
dashboard. If their message references image files (paths, e.g. a screenshot or
mockup), use the Read tool to VIEW them before answering. Your working directory
is the factory WORKSPACE:

- `runs/<newest>/events.jsonl` — the run's ground truth (states, failures,
  reviews, retries, merges). The newest directory under `runs/` is the
  current run.
- `runs/<run>/agents/<task>.stdout.jsonl` — each agent's full activity log.
- `backlog/*.md` — pending tickets; `backlog/done/` — merged ones.
- `runs/<run>/control.jsonl` — APPEND-ONLY operator command channel. To act,
  append one JSON line: {"op": "pause"|"resume"|"stop"} or
  {"op": "kill"|"retry", "task": "<id>"}. The dispatcher applies it within
  a second. Never rewrite this file, only append.

On EVERY message you are given a `# Live run snapshot` block (task states, spend,
recent transitions, what needs attention), already folded from events.jsonl for
you. Treat it as ground truth and answer from it directly — do NOT re-open
events.jsonl just to learn the current state. Open the logs only to fetch a
specific detail the snapshot doesn't carry (e.g. WHY a task failed, an agent's
recent reasoning), and only the END of the relevant file.

Rules:
- Ground every claim in the snapshot or a file you actually read. Never invent
  task states.
- When you must read further, read the END of events.jsonl / an agent's stdout
  log first (latest lines answer most questions). Never re-read a whole log.
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

Discussing new work: the operator may talk through a FEATURE or change they want
built, rather than steering the current run. Engage — ask what's needed, weigh
options against what you can see of the repo — and once the intent is clear,
propose a "plan" suggestion (below): its "goal" is YOUR crisp, self-contained
articulation of what they want, enough for the ticket planner to explore the repo
and draft tickets from it WITHOUT your back-and-forth. Do NOT write the tickets
yourself when you propose a plan — the planner drafts them. (If the operator
instead says to just create the tickets now, write them into backlog/ directly,
as the rules above allow.) Propose at most one "plan", only when the ask is clear.

End your final message with a strict JSON block (no fences):
{"status": "done", "reply": "<your answer to the operator, plain language>",
 "actions": ["<one short line per action taken, empty if none>"],
 "suggestions": [{"op": "retry|kill|pause|resume|stop", "task": "<id if the op needs one>",
                  "label": "<=3-word button text>"},
                 {"op": "plan",
                  "goal": "<crisp, self-contained description of the work to build>",
                  "label": "<=3-word button text>"}]}

"suggestions" are one-click next steps you RECOMMEND but did NOT perform — the
operator clicks to apply them. Only propose what genuinely fits: a control op
(retry a task that failed on a flake, kill a runaway one), or a "plan" to draft
tickets for work just discussed. Leave it empty when nothing is worth proposing.
"task" is required for retry/kill, omitted for pause/resume/stop; "goal" is
required for plan.
"""

#: Control ops the operator can trigger from a one-click suggestion.
_SUGGESTION_OPS = frozenset({"retry", "kill", "pause", "resume", "stop"})


def _clean_suggestions(raw: object) -> list[dict]:
    """Keep only well-formed suggestions: a control op (with a task id when the op
    needs one), or a "plan" carrying a goal for the ticket planner. Anything odd is
    dropped rather than trusted."""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        op = str(item.get("op", "")).strip()
        label = str(item.get("label", "")).strip()[:24]
        if op == "plan":
            # A hand-off to the planner: the goal is the supervisor's articulation
            # of what to build. Useless without it, so drop a goal-less plan.
            goal = str(item.get("goal", "")).strip()
            if not goal:
                continue
            out.append({"op": "plan", "goal": goal[:2000], "label": label or "Draft tickets"})
            continue
        if op not in _SUGGESTION_OPS:
            continue
        task = str(item.get("task", "")).strip()
        if op in ("retry", "kill") and not task:
            continue
        entry = {"op": op, "label": label or op.capitalize()}
        if task:
            entry["task"] = task
        out.append(entry)
    return out


class SuperviseError(Exception):
    """Supervisor infrastructure failed; message is operator-actionable."""


def _session_file(workdir: Path) -> Path:
    return workdir / ".supervisor-session"


async def ask(
    cfg: Config,
    workdir: Path,
    message: str,
    log_path: Path,
    runs_dir: Path | None = None,
    on_activity: Callable[[dict], None] | None = None,
) -> dict:
    """One supervisor exchange; resumes the previous session when one exists.

    A `# Live run snapshot` (folded from events.jsonl) is prepended to every
    message so the supervisor answers without re-tailing logs. ``on_activity``
    fires per assistant turn so a caller can stream progress to the operator.
    """
    cmd = build_cli(
        cfg.agent.command,
        max_turns=30,
        allowed_tools=cfg.supervisor.allowed_tools,
        model=cfg.supervisor.model or cfg.agent.model,
        missing=SuperviseError,
    )

    runs_dir = runs_dir if runs_dir is not None else (workdir / "runs")
    snapshot = run_digest(runs_dir)
    preamble = f"{snapshot}\n\n---\n\n" if snapshot else ""

    session_file = _session_file(workdir)
    resumed = session_file.exists()
    if resumed:
        # Resume keeps the whole conversation: the contract is already in context.
        # The snapshot is still re-sent — the run state has moved since last turn.
        cmd += ["--resume", session_file.read_text(encoding="utf-8").strip()]
        prompt = f"{preamble}# Operator\n\n{message}\n"
    else:
        prompt = f"{SUPERVISOR_CONTRACT}\n\n---\n\n{preamble}# Operator\n\n{message}\n"

    try:
        out = await stream_headless(
            cmd, prompt, workdir, log_path, timeout_s=cfg.supervisor.timeout_min * 60,
            on_activity=on_activity,
            env=spawn_env(cfg.execution_mode),
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
        return await ask(cfg, workdir, message, log_path, runs_dir, on_activity)
    if out.returncode != 0 or out.result is None:
        raise SuperviseError(out.stderr_tail or f"supervisor exited {out.returncode}")

    if session := out.result.get("session_id"):
        session_file.write_text(str(session), encoding="utf-8")

    contract = extract_trailing_json(str(out.result.get("result", "")))
    if contract is None or "reply" not in contract:
        # Fall back to the raw final text rather than losing the answer.
        return {"reply": str(out.result.get("result", ""))[:4000], "actions": [], "suggestions": []}
    return {
        "reply": str(contract.get("reply", "")),
        "actions": [str(a) for a in contract.get("actions", [])],
        "suggestions": _clean_suggestions(contract.get("suggestions")),
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
