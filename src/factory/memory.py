"""Lesson recall: turn the operator's learned facts into prompt context.

The dashboard is the source of truth for lessons — it writes human-editable
JSON files (`memory.json` per project, `memory.global.json` shared across
projects), one fact per entry. This module reads those files and, for each
ticket, selects the most relevant lessons to inject into the agent's prompt so
a mistake recorded once is not repeated.

Ranking is delegated to the `memorymcp` library when it is installed (semantic
if `fastembed` is available, keyword otherwise). When `memorymcp` is absent the
module degrades to a dependency-free keyword ranker, so a run never fails for
lack of an optional package. Everything here runs fully offline: no network, no
model download at run time unless the operator opted into the semantic extra.
"""

from __future__ import annotations

import json
import logging
import os
import re
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from .task import Task

#: How many lessons to inject at most, and how much of a ticket body to use as
#: the recall query. Small caps keep the prompt focused and the cost bounded.
_MAX_LESSONS = 8
_QUERY_BODY_CHARS = 600
_NAMESPACE = "lessons"

#: How often each lesson has actually been injected into an agent's prompt. The
#: factory is the ONLY writer (single-writer per file, like events.jsonl); the
#: dashboard reads it to show "used N times" on a lesson.
APPLIED_FILENAME = "memory.applied.json"


def record_applications(workspace: Path, fact_ids: list[str]) -> None:
    """Increment the use counter for each applied lesson. Best-effort: a failure
    to persist the tally must never affect the run."""
    if not fact_ids:
        return
    path = workspace / APPLIED_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        counts = dict(raw.get("counts", {})) if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        counts = {}
    for fid in fact_ids:
        counts[fid] = int(counts.get(fid, 0)) + 1
    with suppress(OSError):
        path.write_text(json.dumps({"counts": counts}, indent=2), encoding="utf-8")


_WORD_RE = re.compile(r"[a-z0-9]+")

#: Common words carry no signal for matching a lesson to a ticket; dropping them
#: stops "the"/"a"/"is" from making every lesson look relevant.
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "be", "with", "from", "not", "it", "its", "this", "that", "as", "at", "by",
    "into", "you", "your", "we", "our", "i", "they", "them", "then", "than",
    "but", "if", "so", "no", "yes", "do", "does", "done", "was", "were", "has",
    "have", "had", "will", "can", "could", "should", "would", "when", "where",
    "which", "who", "what", "how", "why", "all", "any", "each", "some", "more",
    "most", "only",
})


@dataclass
class _Lesson:
    text: str
    scope: str  # "project" | "global"
    ticket_id: str | None
    fact_id: str | None = None


@dataclass
class Recall:
    """The rendered lesson block plus the ids of the facts that made it in, so
    the caller can record how often each lesson actually gets applied."""

    text: str
    fact_ids: list[str]


def _read_facts(file: Path, scope: str) -> list[_Lesson]:
    """Parse one dashboard memory file. Malformed/missing → empty, never raises."""
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    facts = raw.get("facts") if isinstance(raw, dict) else None
    if not isinstance(facts, list):
        return []
    out: list[_Lesson] = []
    for f in facts:
        if not isinstance(f, dict):
            continue
        text = str(f.get("text", "")).strip()
        if not text:
            continue
        out.append(_Lesson(
            text=text, scope=scope, ticket_id=f.get("ticketId") or None,
            fact_id=str(f["id"]) if f.get("id") else None,
        ))
    return out


def _keyword_rank(lessons: list[_Lesson], query: str, top_k: int) -> list[_Lesson]:
    """Overlap of query tokens with lesson tokens. Ties keep source order."""
    q = {w for w in _WORD_RE.findall(query.lower()) if w not in _STOPWORDS}
    if not q:
        return lessons[:top_k]
    scored = [
        (len(q & {w for w in _WORD_RE.findall(lsn.text.lower()) if w not in _STOPWORDS}), i, lsn)
        for i, lsn in enumerate(lessons)
    ]
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [lsn for score, _, lsn in scored if score > 0][:top_k]


class LessonStore:
    """Reads lesson files once, ranks per ticket, renders a prompt block.

    Global lessons are universal rules and are always injected; project lessons
    are ranked against the ticket so the most relevant ones surface first.
    """

    def __init__(self, project_file: Path | None, global_file: Path | None):
        self._project_file = project_file
        self._global_file = global_file
        self._project: list[_Lesson] = []
        self._global: list[_Lesson] = []
        self._pipeline = None  # a memorymcp MemoryPipeline, or None (keyword mode)

    @classmethod
    def discover(cls, run_dir: Path) -> LessonStore:
        """Locate the lesson files relative to the run.

        A run lives at ``<workspace>/runs/<run_id>``; the project's lessons sit
        at ``<workspace>/memory.json``. The dashboard passes the shared global
        file's path via ``FACTORY_GLOBAL_MEMORY`` (it lives outside the
        workspace, next to the workspace registry).
        """
        workspace = run_dir.parent.parent
        project_file = workspace / "memory.json"
        global_env = os.environ.get("FACTORY_GLOBAL_MEMORY", "").strip()
        global_file = Path(global_env) if global_env else None
        return cls(project_file if project_file.exists() else None, global_file)

    async def load(self) -> None:
        """Read the files and, if memorymcp is installed, index project lessons."""
        if self._project_file:
            self._project = _read_facts(self._project_file, "project")
        if self._global_file and self._global_file.exists():
            self._global = _read_facts(self._global_file, "global")
        if self._project:
            self._pipeline = await self._build_pipeline(self._project)

    async def _build_pipeline(self, lessons: list[_Lesson]):
        """Best-effort memorymcp pipeline; None on any failure (→ keyword mode)."""
        try:
            _quiet_memorymcp_logs()
            from memorymcp import MemoryFactory  # type: ignore

            pipeline = _make_pipeline(MemoryFactory)
            for lesson in lessons:
                await pipeline.store_fact(
                    lesson.text,
                    fact_type="lesson",
                    importance=0.6,
                    tags=[lesson.scope],
                    namespace=_NAMESPACE,
                )
            return pipeline
        except Exception:  # noqa: BLE001 — recall must never break a run
            return None

    async def recall(self, task: Task) -> Recall:
        """The lesson block to inject for a ticket, plus the ids of the facts used."""
        if not self._project and not self._global:
            return Recall("", [])
        query = f"{task.title}\n{task.body[:_QUERY_BODY_CHARS]}"
        project_hits = await self._rank_project(query)
        # Globals first (universal rules), then the ticket-relevant project ones.
        chosen: list[_Lesson] = []
        seen: set[str] = set()
        for lesson in [*self._global, *project_hits]:
            if lesson.text in seen:
                continue
            seen.add(lesson.text)
            chosen.append(lesson)
            if len(chosen) >= _MAX_LESSONS:
                break
        ids = [lesson.fact_id for lesson in chosen if lesson.fact_id]
        return Recall(_render(chosen), ids)

    async def _rank_project(self, query: str) -> list[_Lesson]:
        if not self._project:
            return []
        if self._pipeline is not None:
            try:
                items = await self._pipeline.query_memory(
                    query, namespace=_NAMESPACE, top_k=_MAX_LESSONS
                )
                by_text = {lsn.text: lsn for lsn in self._project}
                ranked = [by_text[it.fact.content] for it in items if it.fact.content in by_text]
                if ranked:
                    return ranked
            except Exception:  # noqa: BLE001 — fall back to keyword ranking
                pass
        return _keyword_rank(self._project, query, _MAX_LESSONS)


def _make_pipeline(memory_factory):
    """A memorymcp pipeline that works offline.

    Prefer the semantic embedder when `fastembed` is importable (real semantic
    ranking); otherwise force the keyword fallback store, which needs no model
    and never reaches out to the network.
    """
    try:
        import fastembed  # noqa: F401  (probe only)

        return memory_factory.default()
    except Exception:  # noqa: BLE001 — no fastembed → deterministic keyword store
        from memorymcp._fallback_semantic import FallbackSemanticStore  # type: ignore

        return memory_factory.create(semantic_store=FallbackSemanticStore())


def _quiet_memorymcp_logs() -> None:
    """Keep memorymcp's structured logs out of the run's captured output."""
    logging.getLogger("memorymcp").setLevel(logging.WARNING)
    try:
        import structlog  # type: ignore

        structlog.configure(
            wrapper_class=structlog.make_filtering_bound_logger(logging.WARNING)
        )
    except Exception:  # noqa: BLE001 — cosmetic only
        pass


def _render(lessons: list[_Lesson]) -> str:
    if not lessons:
        return ""
    lines = []
    for lesson in lessons:
        origin = f" (from {lesson.ticket_id})" if lesson.ticket_id else ""
        lines.append(f"- {lesson.text}{origin}")
    return "\n".join(lines)
