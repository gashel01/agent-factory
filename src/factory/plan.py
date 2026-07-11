"""Co-create tickets with a planning agent.

`factory plan "<goal>"` spawns ONE read-only agent inside the target repo. It
explores the code, decomposes the goal into parallel-safe tickets, and returns
them as structured JSON. The CLI writes them as draft ticket files; the human
reviews with `factory run --dry-run`, edits or deletes, then runs.

The planner proposes, the human disposes — drafts are never executed silently.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from .agent import extract_trailing_json, is_rate_limit_result, stream_headless
from .config import Config

#: Exploration only — the planner must not be able to modify the repo.
PLANNER_TOOLS = ("Read", "Glob", "Grep")

PLANNER_CONTRACT = """\
# Planning contract — Agent Factory

You are a PLANNING agent working inside the target repository (read-only).
Explore the code as needed, then decompose the operator's goal below into
tickets that independent coding agents can execute IN PARALLEL.

Rules for a good decomposition:
- 1 to 8 tickets. Fewer, well-scoped tickets beat many vague ones.
- Each ticket is self-contained: an agent sees only the ticket text and the repo.
- Two tickets must not touch the same files; declare each ticket's files in
  files_hint (paths or directories). Use depends_on only for true ordering.
- Every ticket needs an EXECUTABLE success criterion: a shell command that
  exits 0 on success (a test command, ideally). If the repo has no test setup,
  make ticket 001 "set up the test harness" and let the others depend on it.
- Each body must contain: ## Context, ## Success criteria, ## Out of scope.
- Budget honestly: timeout_min 10-45 depending on size.

End your final message with a strict JSON block (no fences):
{"status": "done", "tickets": [{"id": "001", "title": "...",
 "files_hint": ["src/x.py"], "depends_on": [], "priority": 1,
 "timeout_min": 30, "verify": ["pytest -q"], "body": "## Context\\n..."}]}

If the goal is too vague to decompose safely, return
{"status": "blocked", "summary": "<the precise question you need answered>"}.
"""


class PlanError(Exception):
    """Planner failed; message is operator-actionable."""


def _slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:40] or "ticket"


def _next_free_number(backlog: Path) -> int:
    numbers = [
        int(m.group(1))
        for p in backlog.glob("*.md")
        if (m := re.match(r"(\d+)", p.stem))
    ]
    return max(numbers, default=0) + 1


async def run_planner(cfg: Config, repo: Path, goal: str, log_path: Path) -> dict:
    exe = shutil.which(cfg.agent.command[0])
    if exe is None:
        raise PlanError(f"agent command '{cfg.agent.command[0]}' not found on PATH")
    cmd = [
        exe,
        *cfg.agent.command[1:],
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "40",
        "--allowedTools",
        ",".join(PLANNER_TOOLS),
    ]
    if cfg.agent.model:
        cmd += ["--model", cfg.agent.model]
    prompt = f"{PLANNER_CONTRACT}\n\n---\n\n# Operator goal\n\n{goal}\n"

    try:
        out = await stream_headless(cmd, prompt, repo, log_path, timeout_s=15 * 60)
    except TimeoutError as exc:
        raise PlanError("planner exceeded its 15 min budget") from exc

    if out.stderr_rate_limited or (out.result is not None and is_rate_limit_result(out.result)):
        raise PlanError("rate limit hit while planning — retry later")
    if out.returncode != 0 or out.result is None:
        raise PlanError(f"planner exited {out.returncode} without a result — see {log_path}")
    contract = extract_trailing_json(str(out.result.get("result", "")))
    if contract is None:
        raise PlanError(f"planner returned no JSON plan — see {log_path}")
    if contract.get("status") == "blocked":
        raise PlanError(f"the planner needs an answer first: {contract.get('summary', '?')}")
    if not isinstance(contract.get("tickets"), list) or not contract["tickets"]:
        raise PlanError("planner returned an empty plan")
    return contract


def write_drafts(tickets: list[dict], backlog: Path, repo: Path) -> list[Path]:
    """Materialise planner output as ticket files. IDs are renumbered onto the
    backlog's free range so a plan can extend an existing backlog safely."""
    backlog.mkdir(parents=True, exist_ok=True)
    base = _next_free_number(backlog)
    id_map = {
        str(t.get("id", i)): f"{base + i:03d}" for i, t in enumerate(tickets)
    }
    written: list[Path] = []
    for i, t in enumerate(tickets):
        new_id = f"{base + i:03d}"
        deps = [id_map.get(str(d), str(d)) for d in t.get("depends_on", [])]
        title = str(t.get("title", f"Ticket {new_id}"))
        front = {
            "id": new_id,
            "title": title,
            "repo": repo.resolve().as_posix(),
            "files_hint": list(t.get("files_hint", [])),
            "depends_on": deps,
            "priority": int(t.get("priority", 5)),
            "max_retries": 2,
            "budget": {"timeout_min": int(t.get("timeout_min", 30)), "max_turns": 50},
            "verify": list(t.get("verify", [])),
        }
        lines = ["---"]
        lines.append(f'id: "{front["id"]}"')
        lines.append(f"title: {json.dumps(title)}")
        lines.append(f'repo: {front["repo"]}')
        lines.append(f"files_hint: {json.dumps(front['files_hint'])}")
        lines.append(f"depends_on: {json.dumps(front['depends_on'])}")
        lines.append(f"priority: {front['priority']}")
        lines.append("max_retries: 2")
        lines.append(
            f"budget: {{ timeout_min: {front['budget']['timeout_min']}, max_turns: 50 }}"
        )
        lines.append(f"verify: {json.dumps(front['verify'])}")
        lines.append("---")
        lines.append("")
        lines.append(str(t.get("body", "")).strip())
        lines.append("")
        path = backlog / f"{new_id}-{_slug(title)}.md"
        path.write_text("\n".join(lines), encoding="utf-8")
        written.append(path)
    return written
