"""Co-create tickets with a planning agent.

`factory plan "<goal>"` spawns ONE read-only agent inside the target repo. It
explores the code, decomposes the goal into parallel-safe tickets, and returns
them as structured JSON. The CLI writes them as draft ticket files; the human
reviews with `factory run --dry-run`, edits or deletes, then runs.

The planner proposes, the human disposes — drafts are never executed silently.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .agent import (
    build_cli,
    describe_step,
    extract_trailing_json,
    is_rate_limit_result,
    spawn_env,
    stream_headless,
)
from .config import Config
from .hotspots import brief_for_planner, scan_hotspots
from .task import archived_ids, portable_verify

#: Exploration only — the planner must not be able to modify the repo.
PLANNER_TOOLS = ("Read", "Glob", "Grep")

PLANNER_CONTRACT = """\
# Planning contract — Agent Factory

You are a PLANNING agent working inside the target repository (read-only).
Explore the code as needed, then decompose the operator's goal below into
tickets that independent coding agents can execute IN PARALLEL.

If the goal references image files (paths, e.g. a mockup or screenshot), use the
Read tool to VIEW them before decomposing — they carry visual context the text
alone does not, and any relevant ticket body should point back to them.

Rules for a good decomposition:
- 1 to 8 tickets. Fewer, well-scoped tickets beat many vague ones.
- Each ticket is self-contained: an agent sees only the ticket text and the repo.
- Two tickets must not touch the same files — this holds even for dependent
  tickets. Declare each ticket's files in files_hint (paths or directories).
  Use depends_on only for true ordering, never to split edits to ONE file.
- No overlapping scope. Each ticket must own a DISJOINT slice of work that
  produces its own real diff. If finishing ticket A would naturally also do
  ticket B's work (e.g. A adds a component AND wires it into the same App file
  B was going to edit), they are ONE ticket — merge them. A ticket whose work a
  prior ticket already did has nothing to commit and fails the verify gate.
- A component's BEHAVIOUR and its STYLES are ONE ticket — never split "add the
  logic" from "add the CSS" into separate tickets. The class names, CSS variables
  and element structure they share are an implicit contract, and two isolated
  agents WILL diverge on it (one renders `class="rail-resize"`, the other styles
  `.companion-resize`, both pass typecheck/build, and the feature is silently
  dead). Disjoint FILES do not make coupled work safe to split.
- When a split genuinely spans files with a shared interface (a class name, a CSS
  variable, an exported symbol, a function signature), the dependent ticket MUST
  (a) list the other in depends_on, and (b) restate the EXACT shared names in its
  body, in backticks, as a contract to honour — never let two tickets invent the
  same interface independently.
- Every ticket needs an EXECUTABLE success criterion: a shell command that
  exits 0 on success. PREFER the repo's own test runner (`npm test`, `pytest`)
  over a bare `build`/`tsc` — a build proves the code compiles, a test proves it
  WORKS. Include the build too if you like, but never let "it compiles" be the
  only gate. If the repo has no test setup, make ticket 001 "set up the test
  harness" and let the others depend on it.
- verify commands run through the PLATFORM's default shell — on Windows that is
  cmd.exe, which has NO grep/test/sed/cat/ls. Never use POSIX-only utilities or
  pipe into one. A verify's success is its EXIT CODE, so the runner alone is the
  check: use `npm run build` or `tsc --noEmit`, NEVER `npm run build | grep -q
  'built'`. For content checks use a one-liner in the repo's language (node -e /
  python -c) that exits non-zero on failure.
- Each body must contain: ## Context, ## Success criteria, ## Out of scope.
- Budget honestly: timeout_min 10-45 depending on size.
- Assign each ticket a "model" to control cost. Set "model": "haiku" ONLY for a
  genuinely trivial, mechanical ticket a cheap model nails first try — a config or
  copy tweak, a tiny script, setting up a test harness, a small wiring change. OMIT
  "model" (the run default, a stronger model) for anything logic-heavy, algorithmic,
  or risky: a cheap model there just fails and retries, costing MORE than it saved.
  When unsure, omit it. Most tickets should omit it; reach for haiku deliberately.

Also return a "brief": a compact, durable project map (~150-300 words) that a
FUTURE agent can read INSTEAD of re-exploring the whole repo. Include: what the
project is, the directory layout that matters, key modules/entry points, the
conventions to follow, and the exact build/test commands. If a project map is
already provided below, trust it — verify only what your goal touches — and
return it updated, not rewritten from scratch.

End your final message with a strict JSON block (no fences). "model" is optional —
include it (e.g. "haiku") only on a trivial ticket, omit it otherwise:
{"status": "done", "brief": "<the project map>", "tickets": [{"id": "001",
 "title": "...", "files_hint": ["src/x.py"], "depends_on": [], "priority": 1,
 "timeout_min": 30, "verify": ["pytest -q"], "model": "haiku",
 "body": "## Context\\n..."}]}

If the goal is too vague to decompose safely, return
{"status": "blocked", "summary": "<the precise question you need answered>"}.
"""


PLANNER_QUESTIONS_CONTRACT = """\
# Clarify-first contract — Agent Factory

You are a PLANNING agent working inside the target repository (read-only). Before
decomposing the operator's goal into tickets, you will ask them a few
high-leverage clarifying questions so the plan matches what they actually want.

Explore the code enough to ask GOOD questions — ones whose answer would change
the decomposition: scope boundaries, which of several approaches to take, what to
deliberately leave out, or an ambiguous target you cannot resolve from the code.
Do NOT ask anything you can determine yourself by reading the repo, and do not
ask about coding conventions the code already shows.

Return 2 to 5 questions, most important first (never more than 5). For each, give
2 to 4 concrete suggested answers the operator can pick from — the FIRST being the
sensible default you would assume if they said nothing.

End your final message with a strict JSON block (no fences):
{"status": "questions", "questions": [{"q": "<question>", "why": "<why it changes
 the plan, one line>", "suggestions": ["<default>", "<alternative>", "..."]}]}
"""


#: A durable, human-editable project map, written by the planner and reused by
#: both future planners and every coding agent so the repo isn't re-explored
#: from scratch each time. It describes ONE repository, so it is stored PER-REPO,
#: not per-workspace: a workspace that gets repointed at a different repo (as the
#: dashboard does every time you switch projects) must never serve the previous
#: repo's map to the new one.
BRIEF_DIR = "project-maps"


def _brief_path(workspace: Path, repo: Path) -> Path:
    # Key the map by the repo it describes. Two projects sharing one workspace
    # then can't cross-contaminate, and a brand-new repo simply has no map yet.
    # A readable slug keeps the file human-findable; the path hash keeps it unique
    # across same-named repos in different locations.
    key = repo.resolve()
    digest = hashlib.sha1(str(key).encode("utf-8")).hexdigest()[:8]
    return workspace / BRIEF_DIR / f"{_slug(key.name)}-{digest}.md"


def read_brief(workspace: Path, repo: Path) -> str:
    path = _brief_path(workspace, repo)
    try:
        return path.read_text(encoding="utf-8") if path.exists() else ""
    except OSError:
        return ""


def write_brief(workspace: Path, repo: Path, brief: str) -> None:
    if brief and brief.strip():
        path = _brief_path(workspace, repo)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(brief.strip() + "\n", encoding="utf-8")


class PlanError(Exception):
    """Planner failed; message is operator-actionable."""


def _slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:40] or "ticket"


def _next_free_number(backlog: Path) -> int:
    # Live tickets: the number is the file's leading digits.
    numbers = [
        int(m.group(1))
        for p in backlog.glob("*.md")
        if (m := re.match(r"(\d+)", p.stem))
    ]
    # Already-merged tickets in done/ count too, so numbering never resets and a
    # new plan can't reuse a past id (which would collide on the cumulative board).
    # Their id lives in the front matter (the filename is prefixed by the run id).
    numbers += [int(i) for i in archived_ids(backlog) if i.isdigit()]
    return max(numbers, default=0) + 1


def _with_brief(prompt: str, goal: str, brief: str) -> str:
    prompt = f"{prompt}\n\n---\n\n# Operator goal\n\n{goal}\n"
    if brief.strip():
        # A prior project map: the planner reads this instead of re-exploring the
        # whole repo, cutting tokens on every plan after the first.
        prompt += (
            "\n---\n\n# Project map (from an earlier plan — trust and update it)\n\n"
            f"{brief}\n"
        )
    return prompt


def _hotspot_section(repo: Path) -> str:
    """A deterministic size scan appended to the planner prompt, so the planner
    proposes splitting an oversized file when its work lands on one (advisory —
    it never forces a split). Empty when the repo has no oversized source."""
    note = brief_for_planner(scan_hotspots(repo))
    return f"\n---\n\n{note}\n" if note else ""


async def _stream_contract(cfg: Config, repo: Path, prompt: str, log_path: Path) -> dict:
    """Run ONE read-only planning agent to completion and return its trailing JSON
    contract. Shared by the ticket planner and the clarify-first questioner so
    process handling, live progress and rate-limit/timeout handling exist once."""
    # Planning can run on a cheaper tier than the coding agents. The turn budget
    # has to cover BOTH exploration and emitting the tickets JSON — on a large
    # repo (e.g. the factory's own), a first pass spends heavily on exploration
    # before the map is cached, so keep enough headroom to still land the drafts.
    cmd = build_cli(
        cfg.agent.command,
        max_turns=80,
        allowed_tools=PLANNER_TOOLS,
        model=cfg.plan.model or cfg.agent.model,
        missing=PlanError,
    )

    # Surface the agent's live activity (which files it reads, what it searches)
    # on stdout as it explores, so `factory plan` — and the dashboard that tails
    # it — show a growing feed instead of a silent 1-3 min wait. Deduped so a
    # burst of identical steps doesn't spam the feed.
    last_step: list[str | None] = [None]

    def report(record: dict) -> None:
        step = describe_step(record)
        if step and step != last_step[0]:
            last_step[0] = step
            print(f"· {step}", flush=True)

    try:
        out = await stream_headless(
            cmd, prompt, repo, log_path, timeout_s=15 * 60,
            on_activity=report,
            env=spawn_env(cfg.execution_mode),
        )
    except TimeoutError as exc:
        raise PlanError("planner exceeded its 15 min budget") from exc

    if out.stderr_rate_limited or (out.result is not None and is_rate_limit_result(out.result)):
        raise PlanError("rate limit hit while planning — retry later")
    if out.returncode != 0 or out.result is None:
        raise PlanError(f"planner exited {out.returncode} without a result — see {log_path}")
    contract = extract_trailing_json(str(out.result.get("result", "")))
    if contract is None:
        raise PlanError(f"planner returned no JSON — see {log_path}")
    return contract


async def run_planner(
    cfg: Config, repo: Path, goal: str, log_path: Path, brief: str = ""
) -> dict:
    prompt = _with_brief(PLANNER_CONTRACT, goal, brief) + _hotspot_section(repo)
    contract = await _stream_contract(cfg, repo, prompt, log_path)
    if contract.get("status") == "blocked":
        raise PlanError(f"the planner needs an answer first: {contract.get('summary', '?')}")
    if not isinstance(contract.get("tickets"), list) or not contract["tickets"]:
        raise PlanError("planner returned an empty plan")
    return contract


async def run_questions(
    cfg: Config, repo: Path, goal: str, log_path: Path, brief: str = ""
) -> list[dict]:
    """Clarify-first pass: the planner explores the repo (read-only) and returns a
    short list of high-leverage clarifying questions instead of tickets. The
    operator answers, and their answers are folded into a normal planning pass."""
    prompt = _with_brief(PLANNER_QUESTIONS_CONTRACT, goal, brief) + _hotspot_section(repo)
    contract = await _stream_contract(cfg, repo, prompt, log_path)
    raw = contract.get("questions")
    if not isinstance(raw, list) or not raw:
        raise PlanError("the planner returned no questions — try again or skip plan mode")
    questions: list[dict] = []
    for item in raw[:5]:
        if not isinstance(item, dict):
            continue
        q = str(item.get("q", "")).strip()
        if not q:
            continue
        suggestions = [str(s).strip() for s in _as_list(item.get("suggestions")) if str(s).strip()]
        questions.append({
            "q": q,
            "why": str(item.get("why", "")).strip(),
            "suggestions": suggestions,
        })
    if not questions:
        raise PlanError("the planner returned no usable questions")
    return questions


def _as_list(value: object) -> list[str]:
    """Normalise a planner list-field: a bare string becomes a one-element list,
    NOT a list of its characters (list("src/x.py") == ['s','r','c',…], which
    would poison collision detection). None/missing -> empty."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    return [str(value)]


def _plan_int(value: object, default: int, field: str) -> int:
    try:
        return int(value if value is not None else default)
    except (TypeError, ValueError):
        raise PlanError(f"planner returned a non-numeric {field}: {value!r}") from None


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
        deps = [id_map.get(d, d) for d in _as_list(t.get("depends_on"))]
        title = str(t.get("title", f"Ticket {new_id}"))
        front = {
            "id": new_id,
            "title": title,
            "repo": repo.resolve().as_posix(),
            "files_hint": _as_list(t.get("files_hint")),
            "depends_on": deps,
            "priority": _plan_int(t.get("priority"), 5, "priority"),
            "max_retries": 2,
            "budget": {
                "timeout_min": _plan_int(t.get("timeout_min"), 30, "timeout_min"),
                "max_turns": 65,
            },
            "verify": [portable_verify(c) for c in _as_list(t.get("verify"))],
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
            f"budget: {{ timeout_min: {front['budget']['timeout_min']}, max_turns: 65 }}"
        )
        lines.append(f"verify: {json.dumps(front['verify'])}")
        if t.get("model"):
            lines.append(f"model: {json.dumps(str(t['model']))}")
        lines.append("---")
        lines.append("")
        lines.append(str(t.get("body", "")).strip())
        lines.append("")
        path = backlog / f"{new_id}-{_slug(title)}.md"
        path.write_text("\n".join(lines), encoding="utf-8")
        written.append(path)
    return written
