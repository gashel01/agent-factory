"""One run at a time: an exclusive lockfile per workspace and per repository.

Two dispatchers on the same repository would launch the same tickets twice and
merge concurrently into the operator's checkout. The lock is a small JSON file
created with O_EXCL (atomic on every platform), holding the owner's PID so a
lock left behind by a crashed run is recognised as stale and taken over, not
obeyed forever.

The dashboard reads the workspace lock (`<runs>/.factory.lock`) to refuse
starting a second run and to show that a CLI run is in progress; keep the file
name and JSON shape stable.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

#: Name of the lock inside a workspace's runs directory (read by the dashboard).
WORKSPACE_LOCK = ".factory.lock"
#: Name of the lock inside a repository's git common dir.
REPO_LOCK = "warden-run.lock"


class LockBusy(Exception):
    """Another live run holds the lock; the message names it."""


def pid_alive(pid: int) -> bool:
    """Whether a process with this PID is running.

    Not `os.kill(pid, 0)` on Windows: there it calls TerminateProcess and would
    KILL the process it was meant to probe.
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            # Access denied still means it exists; anything else means it doesn't.
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_lock(path: Path) -> dict | None:
    """The lock's owner record, or None when absent/unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def holder(path: Path) -> dict | None:
    """The live owner of a lock, or None if it's free (absent or stale)."""
    info = read_lock(path)
    if info is None:
        return None
    try:
        pid = int(info.get("pid", 0))
    except (TypeError, ValueError):
        return None
    return info if pid_alive(pid) else None


class RunLock:
    """Hold several lockfiles for the lifetime of a run (context manager).

    Acquisition is all-or-nothing: if any lock is held by a live process, the
    ones already taken are released and LockBusy is raised.
    """

    def __init__(self, paths: list[Path], *, run: str = "", cmd: str = ""):
        self.paths = list(dict.fromkeys(paths))
        self.record = {
            "pid": os.getpid(),
            "started": datetime.now(UTC).isoformat(timespec="seconds"),
            "cmd": cmd or " ".join(sys.argv[:3]),
            "run": run,
        }
        self._held: list[Path] = []

    def _take(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self.record).encode("utf-8")
        for _ in range(2):
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                owner = holder(path)
                if owner is not None:
                    raise LockBusy(
                        f"a run is already in progress (pid {owner.get('pid')}, "
                        f"started {owner.get('started', '?')}, lock {path})"
                    ) from None
                # Stale: its owner is gone. Remove and retry the atomic create once.
                with contextlib.suppress(FileNotFoundError):
                    path.unlink()
                continue
            with os.fdopen(fd, "wb") as fh:
                fh.write(payload)
            self._held.append(path)
            return
        raise LockBusy(f"could not take the run lock {path} (contended)")

    def acquire(self) -> RunLock:
        try:
            for path in self.paths:
                self._take(path)
        except BaseException:
            self.release()
            raise
        return self

    def release(self) -> None:
        for path in reversed(self._held):
            info = read_lock(path)
            if info is not None and info.get("pid") == self.record["pid"]:
                with contextlib.suppress(OSError):
                    path.unlink()
        self._held.clear()

    def __enter__(self) -> RunLock:
        return self.acquire()

    def __exit__(self, *exc: object) -> None:
        self.release()


def repo_lock_path(repo: Path) -> Path:
    """The per-repository lock, inside git's common dir (never in the work tree)."""
    from .worktree import git

    common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return Path(common.stdout.strip()) / REPO_LOCK
