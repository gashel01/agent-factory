"""Append-only JSONL event log — the single source of truth for a run.

The dispatcher is the ONLY writer. Readers (CLI status/report, future dashboard)
tail or replay the file independently, so they can attach, detach, or inspect a
finished run without touching the dispatcher process.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path


class EventLog:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        # A strictly increasing sequence number per log: two events in the same
        # millisecond still have a total order, and a reader can tell a gap (a
        # torn line) from a quiet period. Continues an existing log (recovery
        # appends to a crashed run's file) instead of restarting at zero.
        self._seq = self._count_lines(path)

    @staticmethod
    def _count_lines(path: Path) -> int:
        if not path.exists():
            return 0
        with path.open("rb") as fh:
            return sum(1 for _ in fh)

    def emit(self, event: str, **fields: object) -> dict:
        with self._lock:
            self._seq += 1
            record = {
                "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
                "seq": self._seq,
                "event": event,
                **fields,
            }
            line = json.dumps(record, ensure_ascii=False, default=str)
            # Open/append/flush per event: survives crashes and lets readers tail it.
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
        return record

    @staticmethod
    def replay(path: Path) -> Iterator[dict]:
        """Yield events from a log file, tolerating a torn final line after a crash."""
        if not path.exists():
            return
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue
