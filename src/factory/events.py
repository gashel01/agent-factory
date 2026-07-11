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

    def emit(self, event: str, **fields: object) -> dict:
        record = {
            "ts": datetime.now(UTC).isoformat(timespec="seconds"),
            "event": event,
            **fields,
        }
        line = json.dumps(record, ensure_ascii=False, default=str)
        # Open/append/flush per event: survives crashes and lets readers tail the file.
        with self._lock, self.path.open("a", encoding="utf-8") as fh:
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
