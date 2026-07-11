"""The dispatcher: schedules tasks into slots, enforces budgets, survives rate limits.

Design rules (see AGENT_FACTORY.md):
- `max_slots` is a user parameter with no hard ceiling; the rate-limit handler is
  the real safety net (global pause + exponential backoff, task requeued intact).
- Anti-collision: two tasks whose files_hint overlap never run at the same time.
- Retries re-inject the failure evidence into the ticket; a rate-limit kill is not
  a retry (the task did nothing wrong).
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path

from . import agent as agent_mod
from . import merge as merge_mod
from . import worktree as wt_mod
from .config import Config
from .events import EventLog
from .task import IN_FLIGHT, Task, TaskState
from .verify import run_verify


class Dispatcher:
    def __init__(self, cfg: Config, tasks: list[Task], run_dir: Path):
        self.cfg = cfg
        self.tasks = tasks
        self.by_id = {t.id: t for t in tasks}
        self.run_dir = run_dir
        self.run_id = run_dir.name
        self.log = EventLog(run_dir / "events.jsonl")
        self.state: dict[str, TaskState] = {t.id: TaskState.QUEUED for t in tasks}
        self._active: dict[str, asyncio.Task] = {}
        self._merge_q: asyncio.Queue[tuple[Task, wt_mod.Worktree]] = asyncio.Queue()
        self._pause_until = 0.0
        self._pause_count = 0
        self._stopped = False
        self._contract = self._load_contract()

    # ---------------------------------------------------------------- helpers

    def _load_contract(self) -> str:
        if self.cfg.contract_path and self.cfg.contract_path.exists():
            return self.cfg.contract_path.read_text(encoding="utf-8")
        return agent_mod.DEFAULT_CONTRACT

    def _set_state(self, task: Task, to: TaskState) -> None:
        frm = self.state[task.id]
        self.state[task.id] = to
        self.log.emit("state", task=task.id, **{"from": frm, "to": to})

    def _fail(self, task: Task, reason: str) -> None:
        self.log.emit("failure", task=task.id, reason=reason[:1000])
        self._set_state(task, TaskState.FAILED)

    def _retry_or_fail(self, task: Task, reason: str) -> None:
        task.attempts += 1
        if task.attempts <= task.max_retries:
            task.failure_notes.append(reason[:500])
            self.log.emit("retry", task=task.id, attempt=task.attempts, reason=reason[:500])
            self._set_state(task, TaskState.QUEUED)
        else:
            self._fail(task, f"retries exhausted ({task.attempts - 1}): {reason}")

    def _trigger_pause(self) -> None:
        self._pause_count += 1
        if self._pause_count > self.cfg.ratelimit.max_pauses_before_stop:
            self._stopped = True
            self.log.emit("stopped", reason="rate limit persisted; weekly quota likely exhausted")
            return
        cooldown_s = self.cfg.ratelimit.cooldown_min * 60 * 2 ** (self._pause_count - 1)
        self._pause_until = time.monotonic() + cooldown_s
        self.log.emit("paused_ratelimit", pause_n=self._pause_count, cooldown_s=int(cooldown_s))

    def _in_flight_tasks(self) -> list[Task]:
        return [t for t in self.tasks if self.state[t.id] in IN_FLIGHT]

    def _next_eligible(self) -> Task | None:
        in_flight = self._in_flight_tasks()
        queued = sorted(
            (t for t in self.tasks if self.state[t.id] is TaskState.QUEUED),
            key=lambda t: (t.priority, t.id),
        )
        terminal_bad = (TaskState.FAILED, TaskState.BLOCKED)
        for t in queued:
            dead = [d for d in t.depends_on if self.state[d] in terminal_bad]
            if dead:
                self._fail(t, f"dependency failed: {dead}")
                continue
            if not all(self.state[d] is TaskState.DONE for d in t.depends_on):
                continue
            if any(t.collides_with(other) for other in in_flight):
                continue
            return t
        return None

    def _unfinished(self) -> bool:
        pending = (TaskState.QUEUED, *IN_FLIGHT)
        return any(self.state[t.id] in pending for t in self.tasks)

    # ------------------------------------------------------------------- run

    async def run(self) -> dict[str, int]:
        for repo in {t.repo: None for t in self.tasks}:
            base = next(t.base_branch for t in self.tasks if t.repo == repo)
            wt_mod.preflight(repo, base)
            wt_mod.prune(repo)

        self.log.emit(
            "run_start",
            run=self.run_id,
            slots=self.cfg.max_slots,
            tasks=[{"id": t.id, "title": t.title} for t in self.tasks],
        )
        merger = asyncio.create_task(self._merge_worker())
        try:
            await self._schedule_loop()
            await self._merge_q.join()
        finally:
            merger.cancel()
            with suppress(asyncio.CancelledError):
                await merger

        if self._stopped:
            # Leave unstarted work QUEUED in the log: the backlog is intact on disk
            # and a later run picks it up. Nothing is silently dropped.
            for t in self.tasks:
                if self.state[t.id] is TaskState.QUEUED:
                    self.log.emit("skipped", task=t.id, reason="run stopped on rate limit")

        counts = Counter(str(s) for s in self.state.values())
        self.log.emit("run_end", counts=dict(counts), stopped=self._stopped)
        return dict(counts)

    async def _schedule_loop(self) -> None:
        while self._unfinished():
            self._active = {k: v for k, v in self._active.items() if not v.done()}
            now = time.monotonic()

            if self._stopped and not self._active and self._merge_q.empty():
                break

            paused = now < self._pause_until
            can_launch = (
                not paused
                and not self._stopped
                and len(self._active) < self.cfg.max_slots
            )
            if can_launch and (task := self._next_eligible()):
                self._active[task.id] = asyncio.create_task(self._worker(task))
                await asyncio.sleep(self.cfg.stagger_seconds)
                continue

            if self._active:
                await asyncio.wait(set(self._active.values()), return_when=asyncio.FIRST_COMPLETED)
                continue

            queued = [t for t in self.tasks if self.state[t.id] is TaskState.QUEUED]
            merging = any(self.state[t.id] in (TaskState.MERGE_QUEUED, TaskState.MERGING)
                          for t in self.tasks)
            if merging:
                await asyncio.sleep(0.2)
            elif paused and queued:
                await asyncio.sleep(min(self._pause_until - now, 5.0))
            elif queued:
                # Nothing active, nothing launchable: the remaining graph is unsatisfiable.
                for t in queued:
                    self._fail(t, "unsatisfiable dependencies (circular or all deps failed)")
            else:
                break

    # ---------------------------------------------------------------- worker

    async def _worker(self, task: Task) -> None:
        self._set_state(task, TaskState.RUNNING)
        try:
            wt = await asyncio.to_thread(
                wt_mod.create, task.repo, self.run_dir / "wt", self.run_id, task.id,
                task.base_branch,
            )
        except wt_mod.GitError as exc:
            self._fail(task, f"worktree creation failed: {exc}")
            return

        try:
            log_path = self.run_dir / "agents" / f"{task.id}.stdout.jsonl"
            result = await agent_mod.run_agent(
                self.cfg.agent, task, wt.path, self._contract, log_path
            )
            self.log.emit(
                "agent_result",
                task=task.id,
                status=result.status,
                turns=result.turns,
                wall_s=round(result.wall_s, 1),
                summary=result.summary,
            )

            if result.status == "ratelimit":
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._trigger_pause()
                self._set_state(task, TaskState.QUEUED)  # not a retry: task did nothing wrong
                return
            if result.status == "blocked":
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self.log.emit("blocked", task=task.id, question=result.summary)
                self._set_state(task, TaskState.BLOCKED)
                return
            if result.status in ("timeout", "error"):
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._retry_or_fail(task, f"agent {result.status}: {result.summary}")
                return

            self._set_state(task, TaskState.VERIFYING)
            verdict = await asyncio.to_thread(run_verify, task, wt.path, self.cfg.verify)
            self.log.emit("verify", task=task.id, ok=verdict.ok, failures=list(verdict.failures))
            if not verdict.ok:
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._retry_or_fail(task, "verify failed: " + "; ".join(verdict.failures))
                return

            self._set_state(task, TaskState.MERGE_QUEUED)
            self._merge_q.put_nowait((task, wt))
        except Exception as exc:  # noqa: BLE001 — a worker must never take down the run
            await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
            self._fail(task, f"internal worker error: {exc!r}")

    async def _merge_worker(self) -> None:
        while True:
            task, wt = await self._merge_q.get()
            try:
                self._set_state(task, TaskState.MERGING)
                result = await asyncio.to_thread(
                    merge_mod.merge_branch, task, wt, self.cfg.verify
                )
                if result.ok:
                    self.log.emit("merged", task=task.id, branch=wt.branch)
                    self._set_state(task, TaskState.DONE)
                else:
                    await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                    self._retry_or_fail(task, result.reason)
            except Exception as exc:  # noqa: BLE001
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._fail(task, f"internal merge error: {exc!r}")
            finally:
                self._merge_q.task_done()
