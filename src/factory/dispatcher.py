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
import json
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path

from . import agent as agent_mod
from . import merge as merge_mod
from . import worktree as wt_mod
from .config import Config
from .events import EventLog
from .review import ReviewError, run_review
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
        self._manual_pause = False
        self._stopped = False
        self._control_offset = 0
        self._next_launch_at = 0.0
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

    # ------------------------------------------------------------- control

    def _poll_control(self) -> None:
        """Apply operator commands appended by the dashboard to control.jsonl.

        Mirror of events.jsonl with roles swapped: the dashboard is the only
        writer, the dispatcher the only reader. Offset-based so each command
        is applied exactly once.
        """
        path = self.run_dir / "control.jsonl"
        if not path.exists():
            return
        data = path.read_bytes()
        if len(data) <= self._control_offset:
            return
        chunk = data[self._control_offset :].decode("utf-8", errors="replace")
        # Only consume complete lines; a torn tail is retried on the next poll.
        consumed = chunk.rfind("\n") + 1
        if consumed == 0:
            return
        self._control_offset += len(chunk[:consumed].encode("utf-8"))
        for line in chunk[:consumed].splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                action = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(action, dict):
                self._apply_control(action)

    def _apply_control(self, action: dict) -> None:
        op = action.get("op")
        task_id = action.get("task")
        self.log.emit("control", op=op, task=task_id)
        if op == "pause":
            self._manual_pause = True
            self.log.emit("paused_manual")
        elif op == "resume":
            self._manual_pause = False
            self._pause_until = 0.0  # a human resume overrides a rate-limit pause
            self.log.emit("resumed")
        elif op == "stop":
            self._stopped = True
            self.log.emit("stopped", reason="stopped by the operator")
        elif op == "kill" and task_id in self._active:
            self._active[task_id].cancel()
        elif op == "retry" and task_id in self.by_id:
            task = self.by_id[task_id]
            if self.state[task_id] in (TaskState.FAILED, TaskState.BLOCKED):
                task.attempts = 0  # a human retry grants a fresh budget
                task.failure_notes.append("manually retried from the dashboard")
                self._set_state(task, TaskState.QUEUED)

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
            self._poll_control()
            self._active = {k: v for k, v in self._active.items() if not v.done()}
            now = time.monotonic()

            if self._stopped and not self._active and self._merge_q.empty():
                break

            paused = self._manual_pause or now < self._pause_until
            can_launch = (
                not paused
                and not self._stopped
                and len(self._active) < self.cfg.max_slots
                and now >= self._next_launch_at
            )
            if can_launch and (task := self._next_eligible()):
                # State flips SYNCHRONOUSLY here, not inside the worker coroutine:
                # eligibility must never depend on whether the worker got scheduled
                # yet, or the same task is re-selected in a tight loop that starves
                # the event loop (bug found by faulthandler on 2026-07-11).
                self._set_state(task, TaskState.RUNNING)
                self._active[task.id] = asyncio.create_task(self._worker(task))
                # Stagger as a timestamp, not a sleep: control stays responsive.
                self._next_launch_at = now + self.cfg.stagger_seconds
                await asyncio.sleep(0)  # yield so the worker actually starts
                continue

            if self._active:
                # 1s timeout: workers are awaited AND control keeps being polled.
                await asyncio.wait(
                    set(self._active.values()),
                    return_when=asyncio.FIRST_COMPLETED,
                    timeout=1.0,
                )
                continue

            queued = [t for t in self.tasks if self.state[t.id] is TaskState.QUEUED]
            merging = any(self.state[t.id] in (TaskState.MERGE_QUEUED, TaskState.MERGING)
                          for t in self.tasks)
            if merging:
                await asyncio.sleep(0.2)
            elif queued and (paused or now < self._next_launch_at):
                await asyncio.sleep(min(1.0, max(self._next_launch_at - now, 0.1)))
            elif queued:
                # Nothing active, nothing launchable: the remaining graph is unsatisfiable.
                for t in queued:
                    self._fail(t, "unsatisfiable dependencies (circular or all deps failed)")
            else:
                break

    # ---------------------------------------------------------------- worker

    async def _worker(self, task: Task) -> None:
        # State is already RUNNING — set by the scheduler at launch time.
        try:
            wt = await asyncio.to_thread(
                wt_mod.create, task.repo, self.run_dir / "wt", self.run_id, task.id,
                task.base_branch,
            )
        except wt_mod.GitError as exc:
            self._fail(task, f"worktree creation failed: {exc}")
            return
        except asyncio.CancelledError:
            # Killed before the worktree existed: nothing to clean, but the task
            # must still reach a terminal state or it stays RUNNING forever.
            self._fail(task, "killed by the operator")
            return

        try:
            if self.cfg.setup.commands:
                try:
                    await asyncio.to_thread(
                        wt_mod.run_setup, wt.path, self.cfg.setup.commands,
                        self.cfg.setup.timeout_s,
                    )
                    self.log.emit("setup", task=task.id, ok=True)
                except wt_mod.SetupError as exc:
                    self.log.emit("setup", task=task.id, ok=False, reason=str(exc)[:500])
                    await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                    # Environment problem, not agent failure: retrying without a
                    # config fix would burn attempts for nothing.
                    self._fail(task, f"worktree setup failed: {exc}")
                    return

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
                session_id=result.session_id,
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

            if self.cfg.review.enabled and not await self._review_gate(task, wt):
                return

            self._set_state(task, TaskState.MERGE_QUEUED)
            self._merge_q.put_nowait((task, wt))
        except asyncio.CancelledError:
            # Deliberate operator kill (dashboard). Absorbing the cancellation is
            # intentional: the worker cleans up and records a terminal state.
            await asyncio.shield(asyncio.to_thread(wt_mod.remove, wt, delete_branch=True))
            self._fail(task, "killed by the operator")
        except Exception as exc:  # noqa: BLE001 — a worker must never take down the run
            await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
            self._fail(task, f"internal worker error: {exc!r}")

    async def _review_gate(self, task: Task, wt: wt_mod.Worktree) -> bool:
        """Adversarial review of the diff. True = approved, proceed to merge.

        On a rate limit the completed work is NOT discarded: the gate waits out
        the global pause and reviews again.
        """
        self._set_state(task, TaskState.REVIEWING)
        log_path = self.run_dir / "agents" / f"{task.id}.review.jsonl"
        while True:
            try:
                verdict = await run_review(self.cfg, task, wt.path, log_path)
            except ReviewError as exc:
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._retry_or_fail(task, f"review infrastructure error: {exc}")
                return False
            if not verdict.rate_limited:
                break
            self._trigger_pause()
            if self._stopped:
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._set_state(task, TaskState.QUEUED)  # intact for a later run
                return False
            await asyncio.sleep(max(self._pause_until - time.monotonic(), 1.0))

        self.log.emit("review", task=task.id, verdict=verdict.verdict,
                      reasons=list(verdict.reasons))
        if verdict.verdict != "approve":
            await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
            self._retry_or_fail(task, "review rejected: " + "; ".join(verdict.reasons))
            return False
        return True

    def _archive_ticket(self, task: Task) -> None:
        """Move a merged ticket to backlog/done/ so the next run cannot replay it.

        FAILED and BLOCKED tickets stay in the backlog on purpose: they are
        unfinished work.
        """
        try:
            done_dir = task.path.parent / "done"
            done_dir.mkdir(exist_ok=True)
            target = done_dir / f"{self.run_id}-{task.path.name}"
            task.path.rename(target)
            self.log.emit("archived", task=task.id, to=str(target))
        except OSError as exc:
            # Never fail a merged task over housekeeping; just record it.
            self.log.emit("archive_failed", task=task.id, reason=str(exc))

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
                    self._archive_ticket(task)
                else:
                    await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                    self._retry_or_fail(task, result.reason)
            except Exception as exc:  # noqa: BLE001
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._fail(task, f"internal merge error: {exc!r}")
            finally:
                self._merge_q.task_done()
