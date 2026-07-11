"""Task tickets: one markdown file with YAML front matter = one unit of agent work."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

import yaml


class TicketError(Exception):
    """Raised for malformed tickets; the message names the file and the fix."""


class TaskState(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    VERIFYING = "VERIFYING"
    REVIEWING = "REVIEWING"
    MERGE_QUEUED = "MERGE_QUEUED"
    MERGING = "MERGING"
    DONE = "DONE"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"


#: States that occupy a repo: a colliding task must not start while one of these holds it.
IN_FLIGHT = frozenset(
    {
        TaskState.RUNNING,
        TaskState.VERIFYING,
        TaskState.REVIEWING,
        TaskState.MERGE_QUEUED,
        TaskState.MERGING,
    }
)


@dataclass(frozen=True)
class Budget:
    timeout_min: int = 30
    max_turns: int = 50


@dataclass
class Task:
    id: str
    title: str
    repo: Path
    base_branch: str
    body: str
    path: Path
    files_hint: tuple[str, ...] = ()
    depends_on: tuple[str, ...] = ()
    priority: int = 5
    max_retries: int = 2
    budget: Budget = field(default_factory=Budget)
    verify_commands: tuple[str, ...] = ()
    attempts: int = 0
    failure_notes: list[str] = field(default_factory=list)

    def collides_with(self, other: Task) -> bool:
        """Two tasks collide when they may touch the same files.

        Conservative by design: within one repo, a task without files_hint is
        assumed to touch anything.
        """
        if self.repo != other.repo:
            return False
        if not self.files_hint or not other.files_hint:
            return True
        mine = [_norm(h) for h in self.files_hint]
        theirs = [_norm(h) for h in other.files_hint]
        return any(a == b or a.startswith(b) or b.startswith(a) for a in mine for b in theirs)

    def render(self) -> str:
        """The ticket as the agent sees it. Failure notes from earlier attempts are
        appended so a retry starts from evidence, not from scratch."""
        lines = [
            f"Ticket ID: {self.id}",
            f"Title: {self.title}",
            f"Base branch: {self.base_branch}",
        ]
        if self.verify_commands:
            lines.append("Success criteria commands (must exit 0):")
            lines.extend(f"  - {cmd}" for cmd in self.verify_commands)
        lines.append("")
        lines.append(self.body.strip())
        if self.failure_notes:
            lines.append("\n## Previous attempt feedback (fix these first)")
            lines.extend(f"- {note}" for note in self.failure_notes)
        return "\n".join(lines)


def _norm(hint: str) -> str:
    # Normalised, slash-terminated so "src/auth" never matches "src/auth2".
    return hint.replace("\\", "/").strip("/").lower() + "/"


def parse_ticket(path: Path, default_base_branch: str) -> Task:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise TicketError(f"{path.name}: missing YAML front matter (file must start with '---')")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise TicketError(f"{path.name}: unterminated front matter (missing closing '---')")
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError as exc:
        raise TicketError(f"{path.name}: invalid YAML front matter: {exc}") from exc
    if not isinstance(meta, dict):
        raise TicketError(f"{path.name}: front matter must be a mapping")

    for key in ("id", "title", "repo"):
        if key not in meta:
            raise TicketError(f"{path.name}: missing required field '{key}'")

    repo = Path(str(meta["repo"])).expanduser()
    if not repo.is_absolute():
        repo = (path.parent / repo).resolve()
    if not (repo / ".git").exists():
        raise TicketError(f"{path.name}: repo '{repo}' is not a git repository")

    budget_raw = meta.get("budget", {}) or {}
    unknown = set(budget_raw) - {"timeout_min", "max_turns"}
    if unknown:
        raise TicketError(f"{path.name}: unknown budget keys: {sorted(unknown)}")

    def _str_tuple(key: str) -> tuple[str, ...]:
        value = meta.get(key) or []
        if isinstance(value, str):
            value = [value]
        return tuple(str(v) for v in value)

    return Task(
        id=str(meta["id"]),
        title=str(meta["title"]),
        repo=repo,
        base_branch=str(meta.get("base_branch", default_base_branch)),
        body=parts[2],
        path=path,
        files_hint=_str_tuple("files_hint"),
        depends_on=tuple(str(d) for d in (meta.get("depends_on") or [])),
        priority=int(meta.get("priority", 5)),
        max_retries=int(meta.get("max_retries", 2)),
        budget=Budget(
            timeout_min=int(budget_raw.get("timeout_min", 30)),
            max_turns=int(budget_raw.get("max_turns", 50)),
        ),
        verify_commands=_str_tuple("verify"),
    )


_ID_RE = re.compile(r'^id:\s*["\']?([\w.-]+)["\']?\s*$', re.M)


def archived_ids(backlog_dir: Path) -> set[str]:
    """Ids of tickets already merged and archived to backlog/done/."""
    done = backlog_dir / "done"
    ids: set[str] = set()
    if done.is_dir():
        for path in done.glob("*.md"):
            if match := _ID_RE.search(path.read_text(encoding="utf-8", errors="replace")):
                ids.add(match.group(1))
    return ids


def load_backlog(backlog_dir: Path, default_base_branch: str) -> list[Task]:
    if not backlog_dir.is_dir():
        raise TicketError(f"backlog directory not found: {backlog_dir}")
    tasks = [
        parse_ticket(p, default_base_branch) for p in sorted(backlog_dir.glob("*.md"))
    ]
    if not tasks:
        raise TicketError(f"no *.md tickets found in {backlog_dir}")
    seen: dict[str, Path] = {}
    for t in tasks:
        if t.id in seen:
            raise TicketError(f"duplicate task id '{t.id}' in {t.path.name} and {seen[t.id].name}")
        seen[t.id] = t.path
    ids = set(seen)
    done = archived_ids(backlog_dir)
    for t in tasks:
        # A dependency on an archived (already-merged) ticket is satisfied:
        # drop it so a follow-up run doesn't dead-lock on its own history.
        if satisfied := [d for d in t.depends_on if d in done and d not in ids]:
            t.depends_on = tuple(d for d in t.depends_on if d not in satisfied)
        missing = [d for d in t.depends_on if d not in ids]
        if missing:
            raise TicketError(f"{t.path.name}: depends_on references unknown ids: {missing}")
    return tasks
