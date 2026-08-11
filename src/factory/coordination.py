"""Shared coordination bus for a run — the async seam between isolated agents.

Worktrees keep agents blind to each other's LIVE work (that isolation is what
makes parallelism safe and rollbackable). But some facts a file-collision check
can't catch have to cross that boundary: "the type `DockerStatus` now lives in
settings-modal.tsx — import it, don't redefine it." This bus carries exactly
those cross-cutting facts.

Event-sourced on purpose: an append-only log where content IS data, so the whole
run's coordination is replayable and auditable (it fits the governed model rather
than fighting it). Two consumers sit on top of the one substrate:

  - Level 2 (blackboard):   `world_view()` renders a CURATED snapshot the
                            dispatcher injects into each agent's prompt.
  - Level 3 (world-model):  `whereis()` / `world_index()` answer "who defines X?"
                            over the same events.

Agents never poll — that fights their episodic, headless nature. They READ a
snapshot at start and APPEND via `factory coord`; the dispatcher emits claims and
landings. Coordination happens at the seams, not as a live chat.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# A newly *exported* TS/JS symbol on an added diff line (the ones siblings might
# duplicate). We deliberately track exports, not every local name.
_EXPORT_RE = re.compile(
    r"^\+\s*export\s+(?:default\s+)?(?:async\s+)?"
    r"(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)"
)
_EXPORT_LIST_RE = re.compile(r"^\+\s*export\s+(?:type\s+)?\{([^}]*)\}")
_FILE_RE = re.compile(r"^\+\+\+ b/(.+?)\s*$")


def extract_exports(diff: str) -> dict[str, str]:
    """Map each newly-exported symbol → the file it landed in, from a unified diff.

    This is what turns a merged ticket into world-model knowledge without the agent
    having to remember to announce anything: land `export type DockerStatus` in
    settings-modal.tsx and the next agent's snapshot says it already exists there.
    """
    out: dict[str, str] = {}
    current = ""
    for line in diff.splitlines():
        m = _FILE_RE.match(line)
        if m:
            current = m.group(1)
            continue
        m = _EXPORT_RE.match(line)
        if m:
            out.setdefault(m.group(1), current)
            continue
        m = _EXPORT_LIST_RE.match(line)
        if m:
            for part in m.group(1).split(","):
                name = part.strip()
                if name.startswith("type "):
                    name = name[5:].strip()
                if " as " in name:  # `X as Y` exports Y — the alias is the public name
                    name = name.split(" as ")[-1].strip()
                if name.isidentifier():
                    out.setdefault(name, current)
    return out


class CoordinationBus:
    """Append-only JSONL log for one run. Tolerant reads: a half-written or corrupt
    line is skipped, never fatal — coordination is best-effort, it must not crash a run."""

    def __init__(self, path: Path):
        self.path = path

    def events(self) -> list[dict]:
        if not self.path.exists():
            return []
        out: list[dict] = []
        for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def _append(self, event: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")

    # -- emitters (dispatcher) --
    def claim(self, ticket: str, writes: list[str]) -> None:
        """A ticket has started and intends to write these files."""
        self._append({"kind": "claim", "ticket": ticket, "writes": list(writes)})

    def landed(self, ticket: str, files: list[str], symbols: dict[str, str] | None = None) -> None:
        """A ticket merged: its files (and newly-exported symbols) are now truth."""
        self._append({"kind": "landed", "ticket": ticket,
                      "files": list(files), "symbols": symbols or {}})

    def released(self, ticket: str) -> None:
        """A ticket ended without landing (failed/blocked) — free its claim."""
        self._append({"kind": "released", "ticket": ticket})

    # -- emitters (agent, via `factory coord`) --
    def decision(self, ticket: str, key: str, value: str) -> None:
        """A durable cross-cutting decision keyed for dedup (latest wins)."""
        self._append({"kind": "decision", "ticket": ticket, "key": key, "value": value})

    def discovery(self, ticket: str, note: str) -> None:
        """A free-form fact worth sharing with siblings."""
        self._append({"kind": "discovery", "ticket": ticket, "note": note})


def world_index(events: list[dict]) -> dict:
    """Fold the event log into the current world state (Level 3, queryable).

    Returns: symbols {name -> file}, decisions {key -> (value, ticket)}, and
    in_flight {file -> ticket} for claims that have not yet landed or released.
    Latest claim per file wins; a claim whose ticket has ended is not in flight.
    """
    symbols: dict[str, str] = {}
    decisions: dict[str, tuple[str, str]] = {}
    discoveries: list[tuple[str, str]] = []
    claimed_by: dict[str, str] = {}
    ended: set[str] = set()

    for e in events:
        kind = e.get("kind")
        ticket = str(e.get("ticket", ""))
        if kind == "claim":
            for f in e.get("writes", []):
                claimed_by[f] = ticket  # latest claimer of this file
        elif kind == "landed":
            ended.add(ticket)
            for name, file in (e.get("symbols") or {}).items():
                symbols[str(name)] = str(file)
        elif kind == "released":
            ended.add(ticket)
        elif kind == "decision":
            decisions[str(e.get("key", ""))] = (str(e.get("value", "")), ticket)
        elif kind == "discovery":
            discoveries.append((ticket, str(e.get("note", ""))))

    in_flight = {f: t for f, t in claimed_by.items() if t not in ended}
    return {"symbols": symbols, "decisions": decisions,
            "in_flight": in_flight, "discoveries": discoveries}


def whereis(events: list[dict], symbol: str) -> str:
    """Where does `symbol` live? '' if unknown. Powers `factory coord --whereis`."""
    idx = world_index(events)
    if symbol in idx["symbols"]:
        return idx["symbols"][symbol]
    if symbol in idx["decisions"]:
        return idx["decisions"][symbol][0]
    return ""


def world_view(events: list[dict], for_ticket: str = "") -> str:
    """The curated snapshot injected into an agent's prompt (Level 2 blackboard).

    Curated, not raw: decisions deduped by key, self's own claims filtered out,
    only the last few discoveries. Empty string when there is nothing to say, so
    the dispatcher never pads a prompt with an empty section.
    """
    idx = world_index(events)
    parts: list[str] = []

    in_flight = {f: t for f, t in idx["in_flight"].items() if t != for_ticket}
    if in_flight:
        rows = "\n".join(f"  - {f} (ticket {t})" for f, t in sorted(in_flight.items()))
        parts.append("A sibling is editing these files RIGHT NOW — do not touch them:\n" + rows)

    if idx["symbols"]:
        rows = "\n".join(f"  - {name} → {file}" for name, file in sorted(idx["symbols"].items()))
        parts.append("Symbols already defined elsewhere — IMPORT them, do not recreate:\n" + rows)

    decisions = {k: v for k, v in idx["decisions"].items() if k}
    if decisions:
        rows = "\n".join(f"  - {k}: {val}" for k, (val, _t) in sorted(decisions.items()))
        parts.append("Shared decisions from sibling tickets:\n" + rows)

    recent = [(t, n) for t, n in idx["discoveries"] if t != for_ticket][-5:]
    if recent:
        rows = "\n".join(f"  - {n} (ticket {t})" for t, n in recent)
        parts.append("Recent notes from siblings:\n" + rows)

    return "\n\n".join(parts)
