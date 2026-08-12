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
import contextlib
import json
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path

from . import agent as agent_mod
from . import checkpoint as checkpoint_mod
from . import merge as merge_mod
from . import sandbox as sandbox_mod
from . import worktree as wt_mod
from .config import Config
from .coordination import CoordinationBus, extract_exports, world_view
from .events import EventLog
from .memory import LessonStore, record_applications
from .notify import post_webhook
from .plan import read_brief
from .review import ReviewError, run_review
from .task import IN_FLIGHT, Task, TaskState, TicketError
from .verify import run_integration, run_verify


def _sbx_setup_runner(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
    # Dependency installs are trusted operator config and need pypi/npm, so they
    # get network — but never the auth token (run_command mounts no credentials).
    return sandbox_mod.run_command(cmd, cwd, allow_network=True, timeout_s=timeout_s)


def _sbx_verify_runner(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
    # Verify runs the agent's OWN code (its tests): offline in the box, so a
    # gamed or malicious test can neither exfiltrate nor reach the network.
    return sandbox_mod.run_command(cmd, cwd, allow_network=False, timeout_s=timeout_s)


def _is_noop(task: Task, wt: wt_mod.Worktree) -> bool:
    """True when the agent landed nothing: a clean worktree AND no new commit on the
    branch vs its base. The ticket's change already existed, or there was genuinely
    nothing to do. Landing nothing is a valid outcome — not a failure to retry, and
    never something to force into a commit (the pressure that drives an agent toward
    a destructive `git reset` to manufacture one)."""
    if not wt_mod.is_clean(wt.path):
        return False  # uncommitted work exists — a forgotten commit, not a no-op
    count = wt_mod.git(
        wt.repo, "rev-list", "--count", f"{task.base_branch}..{wt.branch}", check=False
    ).stdout.strip()
    return count in ("", "0")


def _blocked_context(task: Task, wt: wt_mod.Worktree) -> dict:
    """Raw git facts captured the moment an agent blocks — BEFORE its worktree is
    torn down — so the operator sees the ground truth next to the agent's question.
    A 'clean tree, 0 commits' context exposes a bogus request to reset/rewrite: there
    is simply nothing there to lose."""
    commits = wt_mod.git(
        wt.repo, "rev-list", "--count", f"{task.base_branch}..{wt.branch}", check=False
    ).stdout.strip()
    status = wt_mod.git(wt.path, "status", "--short", check=False).stdout.strip()
    stat = wt_mod.git(
        # Three-dot (merge-base): show only what THIS branch changed, so a base
        # that advanced via sibling merges doesn't masquerade as the ticket's work.
        wt.path, "diff", "--stat", f"{task.base_branch}...{wt.branch}", check=False
    ).stdout.strip()
    return {
        "clean": wt_mod.is_clean(wt.path),
        "commits": int(commits) if commits.isdigit() else 0,
        "status": status.splitlines()[:20],
        "diffstat": stat.splitlines()[-15:],
    }


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
        self._spent_usd = 0.0  # cumulative API-equivalent cost across the run
        self._workspace = run_dir.parent.parent
        self._lessons = LessonStore.discover(run_dir)
        # The coordination bus: the async seam where isolated agents share the
        # cross-cutting facts a file-collision check can't catch (a shared type's
        # home, a naming decision). One append-only log per run; agents read a
        # curated snapshot at start and append via `factory coord`.
        self._coord = CoordinationBus(run_dir / "coordination.jsonl")
        # Tickets that recorded a real landing (files/symbols), so a DONE no-op
        # doesn't overwrite them with an empty landing.
        self._landed: set[str] = set()
        # Project map (written by the planner): injected into every agent so
        # tickets don't each re-explore the repo. Scoped to each task's repo —
        # a run spanning several repos serves each its own map, and a workspace
        # reused across projects never leaks the previous repo's map. Cached so
        # the file is read at most once per repo.
        self._brief_cache: dict[Path, str] = {}
        # A blocked agent's question, kept so an operator answer can be paired
        # with what was actually asked when the task is re-queued.
        self._blocked_questions: dict[str, str] = {}
        # When the block was a DECISION (the agent offered concrete options), the
        # question text of that decision is kept here too, so the operator's pick is
        # phrased as a chosen option and recorded on the coordination bus.
        self._pending_decisions: dict[str, str] = {}
        # Control mode: verified tasks whose worktree is parked, waiting for the
        # operator to approve the merge (or request changes) from the dashboard.
        self._awaiting: dict[str, tuple[Task, wt_mod.Worktree]] = {}
        # Token saver: worktrees parked between a retryable failure and its next
        # attempt. The relaunched agent RESUMES its previous session inside the
        # same worktree (work + context intact) instead of restarting cold.
        self._parked_retry: dict[str, wt_mod.Worktree] = {}
        # Repos that received at least one merge this run — the integration check
        # runs the full suite on each once everything has landed.
        self._merged_repos: set[Path] = set()

    # ---------------------------------------------------------------- helpers

    def _load_contract(self) -> str:
        if self.cfg.contract_path and self.cfg.contract_path.exists():
            return self.cfg.contract_path.read_text(encoding="utf-8")
        return agent_mod.DEFAULT_CONTRACT

    def _brief_for(self, repo: Path) -> str:
        """The planner's project map for this task's repo (empty if none yet),
        read at most once per repo."""
        key = repo.resolve()
        if key not in self._brief_cache:
            self._brief_cache[key] = read_brief(self._workspace, key)
        return self._brief_cache[key]

    def _architecture(self) -> str:
        """The operator's living architecture notes (the human half of the shared
        source of truth, edited from the dashboard's Architecture tab). Re-read on
        every dispatch — best-effort — so an edit made mid-run reaches later agents.
        Same file the dashboard writes: <workspace>/architecture.md."""
        path = self._workspace / "architecture.md"
        try:
            return path.read_text(encoding="utf-8").strip() if path.exists() else ""
        except OSError:
            return ""

    def _set_state(self, task: Task, to: TaskState) -> None:
        frm = self.state[task.id]
        self.state[task.id] = to
        self.log.emit("state", task=task.id, **{"from": frm, "to": to})
        # End the ticket's turn at its files when it reaches a terminal/parked
        # state, so the shared space stops showing it "editing now". A DONE that
        # landed already recorded its symbols; a DONE no-op (or PR) marks
        # done-with-nothing-to-land; a FAILED/BLOCKED one is released. A BLOCKED
        # ticket re-claims when it resumes. Best-effort — never blocks a transition.
        with contextlib.suppress(OSError):
            if to == TaskState.DONE and task.id not in self._landed:
                self._coord.landed(task.id, [], {})
            elif to in (TaskState.FAILED, TaskState.BLOCKED):
                self._coord.released(task.id)

    def _escalate_model(self, task: Task) -> None:
        """On a retry, bump the task up the model ladder — cheap tier first, a
        stronger one only when the cheap one couldn't do it. Only moves UP along a
        known ladder: a ticket already on the top tier, or on a model that isn't in
        the ladder at all, is left untouched (never downgraded)."""
        tiers = self.cfg.escalation
        current = task.model or self.cfg.agent.model
        if not tiers or current not in tiers:
            return
        idx = tiers.index(current)
        if idx + 1 < len(tiers):
            task.model = tiers[idx + 1]
            self.log.emit("escalate", task=task.id, **{"from": current, "to": task.model})

    def _fail(self, task: Task, reason: str) -> None:
        # Idempotent: a task that already reached a terminal state must not be
        # failed again. Otherwise a worker cancelled DURING run shutdown (asyncio
        # cancels every worker, even ones whose task already finished) re-emits a
        # spurious "killed by the operator" over the real reason — which also hid
        # the true failure from the "why did it fail?" diagnostic.
        if self.state[task.id] in (TaskState.DONE, TaskState.FAILED, TaskState.BLOCKED):
            return
        self.log.emit("failure", task=task.id, reason=reason[:1000])
        # _set_state(FAILED) frees this ticket's claim on the bus (below).
        self._set_state(task, TaskState.FAILED)

    def _record_landing(self, task: Task, base_sha: str, head_sha: str) -> None:
        """Fold a merged ticket into the world-model: its files and newly-exported
        symbols become facts the next agent's snapshot carries. base_sha..head_sha
        brackets exactly this ticket's work. Best-effort — never affects the run."""
        if not base_sha or not head_sha:
            return
        with contextlib.suppress(OSError):
            rng = f"{base_sha}..{head_sha}"
            diff = wt_mod.git(task.repo, "diff", rng, check=False).stdout
            names = wt_mod.git(task.repo, "diff", "--name-only", rng, check=False).stdout
            files = [f for f in names.splitlines() if f.strip()]
            self._coord.landed(task.id, files, extract_exports(diff))
            self._landed.add(task.id)  # so the DONE transition won't blank it

    async def _notify(self, message: str) -> None:
        """Fire an external webhook (Slack/Discord/generic), best-effort. A flaky
        or absent webhook never affects the run — it just no-ops."""
        url = self.cfg.notify.webhook_url
        if not url:
            return
        ok = await asyncio.to_thread(post_webhook, url, f"[Agent Factory] {message}")
        self.log.emit("notified", ok=ok, message=message[:200])

    def _retry_or_fail(self, task: Task, reason: str) -> bool:
        """Requeue with evidence, or fail when retries are exhausted.

        Returns True when the task was requeued (the caller may then park its
        worktree for a session-resumed retry), False when it failed for good.
        """
        task.attempts += 1
        if task.attempts <= task.max_retries:
            task.failure_notes.append(reason[:500])
            self._escalate_model(task)
            self.log.emit("retry", task=task.id, attempt=task.attempts, reason=reason[:500])
            self._set_state(task, TaskState.QUEUED)
            return True
        self._fail(task, f"retries exhausted ({task.attempts - 1}): {reason}")
        return False

    async def _retryable_failure(
        self, task: Task, wt: wt_mod.Worktree, session: str | None, reason: str
    ) -> None:
        """A failure worth retrying: requeue with evidence, and when a session id
        exists PARK the worktree so the next attempt resumes the same agent in
        the same place (work + context intact — a fraction of a cold restart).
        Without a session, or when retries are exhausted, clean up as before."""
        requeued = self._retry_or_fail(task, reason)
        if requeued and session:
            task.resume_session = session
            self._parked_retry[task.id] = wt
        else:
            task.resume_session = None
            await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)

    def _enforce_budget(self) -> None:
        """Stop launching new agents once the run's cost ceiling is crossed.

        In-flight agents finish (their work isn't wasted); queued work stays on
        disk for a later run. The operator can raise the budget and re-run.
        """
        cap = self.cfg.budget_usd
        if cap is not None and self._spent_usd >= cap and not self._stopped:
            self._stopped = True
            self.log.emit(
                "budget_exceeded",
                spent_usd=round(self._spent_usd, 4),
                budget_usd=cap,
            )
            self.log.emit("stopped", reason=f"budget reached (${self._spent_usd:.2f} / ${cap:.2f})")

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

    async def _poll_control(self) -> None:
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
                await self._apply_control(action)

    async def _apply_control(self, action: dict) -> None:
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
        elif op == "kill":
            # Cancel a ticket at any pre-merge stage. An active worker (RUNNING /
            # VERIFYING / REVIEWING) is cancelled — its except-CancelledError path
            # cleans up and fails it. A ticket parked in AWAITING_APPROVAL has no
            # live worker: discard its validated branch here and drop the ticket.
            if task_id in self._active:
                self._active[task_id].cancel()
            elif task_id in self._awaiting:
                task, wt = self._awaiting.pop(task_id)
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._fail(task, "cancelled by the operator before merge")
            elif task_id in self.by_id and self.state[task_id] is TaskState.QUEUED:
                # Not started yet: just drop it so it never launches.
                self._fail(self.by_id[task_id], "cancelled by the operator before it started")
        elif op == "retry" and task_id in self.by_id:
            task = self.by_id[task_id]
            if self.state[task_id] in (TaskState.FAILED, TaskState.BLOCKED):
                task.attempts = 0  # a human retry grants a fresh budget
                task.failure_notes.append("manually retried from the dashboard")
                self._set_state(task, TaskState.QUEUED)
        elif op == "approve" and task_id in self._awaiting:
            task, wt = self._awaiting.pop(task_id)
            self.log.emit("approved", task=task_id)
            self._set_state(task, TaskState.MERGE_QUEUED)
            self._merge_q.put_nowait((task, wt))
        elif op == "changes" and task_id in self._awaiting:
            task, wt = self._awaiting.pop(task_id)
            feedback = str(action.get("text", "")).strip()
            # Throw the branch away and re-queue with the operator's notes, so the
            # next attempt starts from the requested changes, not from scratch.
            # Off-thread so a slow `git worktree remove` (Windows/AV file locks)
            # doesn't stall the whole event loop; awaited so the worktree is gone
            # before the relaunch re-creates one at the same path.
            await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
            task.attempts = 0
            if feedback:
                task.failure_notes.append(f"The operator reviewed your work and asked: {feedback}")
            self.log.emit("changes_requested", task=task_id, reason=feedback[:500])
            self._set_state(task, TaskState.QUEUED)
        elif op == "undo" and task_id in self._awaiting:
            # Rewind a parked (approval-pending) branch to one of its checkpoints.
            # Safe: the worktree has no live worker, and the branch is un-merged
            # scratch history. Only a SHA we actually handed out is accepted.
            task, wt = self._awaiting[task_id]
            sha = str(action.get("to", "")).strip()
            valid = {c["sha"] for c in checkpoint_mod.list_checkpoints(wt.path, task.base_branch)}
            if sha not in valid:
                return
            try:
                checkpoint_mod.undo_to(wt.path, sha)
            except wt_mod.GitError:
                self.log.emit("control", op="undo_failed", task=task_id)
                return
            # Re-emit the parked state so the dashboard refreshes the diff range and
            # the now-shorter checkpoint list.
            base = wt_mod.git(wt.repo, "rev-parse", task.base_branch, check=False).stdout.strip()
            head = wt_mod.git(wt.repo, "rev-parse", wt.branch, check=False).stdout.strip()
            cps = checkpoint_mod.list_checkpoints(wt.path, task.base_branch)
            self.log.emit(
                "awaiting_approval", task=task_id, repo=str(task.repo),
                base=base, commit=head, checkpoints=cps,
            )
            self.log.emit("undone", task=task_id, to=sha[:8])
        elif op == "answer" and task_id in self.by_id:
            task = self.by_id[task_id]
            answer = str(action.get("text", "")).strip()
            # An empty answer carries no information: leave the task blocked so the
            # operator can try again, rather than silently burning an attempt.
            if self.state[task_id] is TaskState.BLOCKED and answer:
                task.attempts = 0  # answering grants a fresh budget, like a retry
                question = self._blocked_questions.pop(task_id, "")
                decision_q = self._pending_decisions.pop(task_id, "")
                if decision_q:
                    # The operator picked one of the options the agent offered. Phrase
                    # it as a settled choice, and record it on the coordination bus so
                    # the decision becomes part of the shared world-model (Architecture).
                    note = (
                        f"You raised a decision: {decision_q}\n  The operator chose: "
                        f"{answer}\n  Build exactly that choice and finish the ticket."
                    )
                    with contextlib.suppress(OSError):
                        self._coord.decision(task_id, decision_q[:80], answer[:200])
                else:
                    note = (
                        f"You reported BLOCKED and asked: {question}\n  The operator answered: "
                        f"{answer}\n  Use this answer to finish the ticket."
                        if question
                        else f"The operator answered your blocking question: {answer}"
                    )
                task.failure_notes.append(note)
                self.log.emit("answered", task=task_id)
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
            # One repo, one base branch. A backlog mixing e.g. main + develop in
            # the same repo would pass preflight on the first task's base, then
            # fail each mismatched task at merge time with an opaque "preflight
            # drift" — so reject it up front with the actual conflict.
            bases = {t.base_branch for t in self.tasks if t.repo == repo}
            if len(bases) > 1:
                raise TicketError(
                    f"repo '{repo}' has tickets on different base branches "
                    f"({', '.join(sorted(bases))}); one repo must use a single base "
                    f"branch per run — split them into separate runs."
                )
            base = bases.pop()
            wt_mod.preflight(repo, base)
            wt_mod.prune(repo)
            self._sync_base(repo, base)

        await self._lessons.load()

        self.log.emit(
            "run_start",
            run=self.run_id,
            slots=self.cfg.max_slots,
            budget_usd=self.cfg.budget_usd,
            mode=self.cfg.execution_mode,
            pr=self.cfg.pr.enabled,
            tasks=[
                {"id": t.id, "title": t.title, "model": t.model, "effort": t.effort,
                 "depends_on": list(t.depends_on)}
                for t in self.tasks
            ],
        )
        merger = asyncio.create_task(self._merge_worker())
        try:
            await self._schedule_loop()
            await self._merge_q.join()
            await self._run_integration_check()
        except (asyncio.CancelledError, KeyboardInterrupt):
            # Ctrl+C or a cancelled run: fall through to the cleanup below so the
            # log still gets a terminal state for every task and a run_end.
            self._stopped = True
        finally:
            # Cancel in-flight workers so their agent subprocesses are killed
            # rather than orphaned (a leftover `claude` keeps burning credits with
            # no dispatcher to stop it). Each worker catches the cancellation,
            # cleans its worktree, and records a terminal state.
            merger.cancel()
            for worker in list(self._active.values()):
                worker.cancel()
            for pending in (merger, *self._active.values()):
                with suppress(asyncio.CancelledError, Exception):
                    await pending

            # CRITICAL: a task left in-flight when we exit (crash, Ctrl+C, the
            # terminal window closed) shows in the dashboard as a "still working"
            # ghost forever, and its operator commands reach a dispatcher that no
            # longer exists. Force every unfinished task to a terminal state and
            # always write run_end — the reader must be able to tell a live run
            # from a dead one.
            # Parked-for-approval worktrees would otherwise be orphaned on disk.
            for tid, (task, wt) in list(self._awaiting.items()):
                with suppress(Exception):
                    wt_mod.remove(wt, delete_branch=True)
                self._awaiting.pop(tid, None)
                self._fail(task, "run stopped before you approved the merge")
            # Same for worktrees parked between a failure and its resumed retry.
            for tid, wt in list(self._parked_retry.items()):
                with suppress(Exception):
                    wt_mod.remove(wt, delete_branch=True)
                self._parked_retry.pop(tid, None)
            for t in self.tasks:
                if self.state[t.id] in IN_FLIGHT:
                    self._fail(t, "interrupted before completion (the run stopped)")
            if self._stopped:
                # Unstarted work stays recoverable: the backlog is intact on disk
                # and a later run picks it up. Nothing is silently dropped.
                for t in self.tasks:
                    if self.state[t.id] is TaskState.QUEUED:
                        self.log.emit("skipped", task=t.id, reason="run stopped")
            counts = Counter(str(s) for s in self.state.values())
            self.log.emit("run_end", counts=dict(counts), stopped=self._stopped)
            merged = counts.get(str(TaskState.DONE), 0)
            failed = counts.get(str(TaskState.FAILED), 0)
            blocked = counts.get(str(TaskState.BLOCKED), 0)
            verb = "stopped" if self._stopped else "finished"
            parts = [f"{merged} merged"]
            if failed:
                parts.append(f"{failed} failed")
            if blocked:
                parts.append(f"{blocked} blocked")
            with suppress(Exception):
                await self._notify(f"Run {verb} — {', '.join(parts)}.")

        return dict(counts)

    def _sync_base(self, repo: Path, base: str) -> None:
        """Before spawning agents, tell whether the local base drifted from the
        remote and fast-forward it if it is purely behind (e.g. PRs merged on
        GitHub since the last run). Only pulls when behind, not ahead, and clean —
        never rewrites local work. Emits a `sync` event either way."""
        if not wt_mod.remotes(repo):
            return
        wt_mod.fetch(repo)
        ab = wt_mod.ahead_behind(repo, base)
        if ab is None:
            return
        ahead, behind = ab
        pulled = False
        if behind > 0 and ahead == 0 and wt_mod.is_clean(repo):
            pulled = wt_mod.pull_ff(repo, base)
        self.log.emit(
            "sync", repo=str(repo), base=base, ahead=ahead, behind=behind, pulled=pulled,
        )

    async def _run_integration_check(self) -> None:
        """Once every ticket has merged, run the integration suite on each affected
        repo's base branch. Off unless `integration.commands` is configured; a red
        check does NOT unmerge (the operator decides) — it is a loud, honest signal
        that the combined result needs attention."""
        if self._stopped or not self.cfg.integration.commands or not self._merged_repos:
            return
        for repo in sorted(self._merged_repos, key=str):
            self.log.emit("integration_start", repo=str(repo))
            result = await asyncio.to_thread(run_integration, repo, self.cfg.integration)
            self.log.emit(
                "integration", repo=str(repo), ok=result.ok,
                failures=list(result.failures)[:20],
            )

    async def _schedule_loop(self) -> None:
        while self._unfinished():
            await self._poll_control()
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
            elif self._awaiting:
                # Control mode: tasks are parked waiting for your approval. Keep the
                # run alive and control-responsive — and never call a queued task
                # "unsatisfiable" when its dependency is only waiting to be approved.
                await asyncio.sleep(0.3)
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
        # A parked worktree from a retryable failure is reused as-is: the agent
        # resumes its session there, and setup is already done (both are paid
        # only once per task, not once per attempt).
        parked = self._parked_retry.pop(task.id, None)
        if parked is not None:
            wt = parked
        else:
            task.resume_session = None  # fresh worktree ⇒ a resume would desync
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

        sandboxed = self.cfg.isolation == "sandbox"
        try:
            if sandboxed and parked is None:
                # Bring the isolation infra up ONCE before setup/agent/verify (all
                # run in the box). Fails the task early with an actionable message
                # if Docker or the image isn't ready, instead of deep in a phase.
                try:
                    await asyncio.to_thread(sandbox_mod.ensure_infra)
                except sandbox_mod.SandboxError as exc:
                    await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                    self._fail(task, f"sandbox unavailable: {exc}")
                    return
            if self.cfg.setup.commands and parked is None:
                try:
                    await asyncio.to_thread(
                        wt_mod.run_setup, wt.path, self.cfg.setup.commands,
                        self.cfg.setup.timeout_s,
                        _sbx_setup_runner if sandboxed else None,
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
            recall = await self._lessons.recall(task)
            if recall.text:
                self.log.emit(
                    "lessons", task=task.id, count=len(recall.fact_ids), ids=recall.fact_ids
                )
                record_applications(self._workspace, recall.fact_ids)

            # Announce this ticket's intended write-set on the bus (so siblings see
            # it in flight), then hand it the CURATED snapshot of what the others
            # have claimed, decided and landed. Best-effort: a bus hiccup must
            # never sink a run, so it's guarded.
            coord_text = ""
            with contextlib.suppress(OSError):
                self._coord.claim(task.id, list(task.files_hint))
                coord_text = world_view(self._coord.events(), for_ticket=task.id)
            def _progress(turns: int, tokens: int) -> None:
                # Live per-agent activity (C6): one event per turn, so the card shows
                # a growing turn/token count while the agent works, not just at the end.
                self.log.emit("agent_progress", task=task.id, turns=turns, tokens=tokens)

            result = await agent_mod.run_agent(
                self.cfg.agent, task, wt.path, self._contract, log_path, recall.text,
                self._brief_for(task.repo), architecture=self._architecture(),
                on_progress=_progress,
                mode=self.cfg.execution_mode,
                isolation=self.cfg.isolation,
                coordination=coord_text,
                coord_path=self._coord.path,
            )
            u = result.usage
            self._spent_usd += u.cost_usd
            # Remember the session so a later-stage failure (merge conflict,
            # review rejection) can resume this agent rather than restart cold.
            task.last_session = result.session_id
            self.log.emit(
                "agent_result",
                task=task.id,
                status=result.status,
                turns=result.turns,
                wall_s=round(result.wall_s, 1),
                summary=result.summary,
                session_id=result.session_id,
                cost_usd=round(u.cost_usd, 4),
                input_tokens=u.input_tokens,
                output_tokens=u.output_tokens,
                cache_read_tokens=u.cache_read_tokens,
                spent_usd=round(self._spent_usd, 4),
            )
            if result.rate_limit_info:
                # Plan-window snapshot (subscription): reset time + status, so the
                # dashboard can show how close the plan is to its limit.
                rli = result.rate_limit_info
                self.log.emit(
                    "plan_limit",
                    status=str(rli.get("status", "")),
                    resets_at=rli.get("resetsAt"),
                    window=str(rli.get("rateLimitType", "")),
                )
            self._enforce_budget()

            if result.status == "ratelimit":
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._trigger_pause()
                self._set_state(task, TaskState.QUEUED)  # not a retry: task did nothing wrong
                return
            if result.status == "decision":
                # The agent reached a genuine fork it must not decide alone: it
                # offered concrete options. Park it like a block (same answer→resume
                # machinery), but carry the options so the dashboard renders a pick
                # instead of a free-text answer box.
                ctx = await asyncio.to_thread(_blocked_context, task, wt)
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._blocked_questions[task.id] = result.summary
                self._pending_decisions[task.id] = result.summary
                self.log.emit(
                    "blocked", task=task.id, question=result.summary, context=ctx,
                    kind="decision", options=list(result.options),
                )
                self._set_state(task, TaskState.BLOCKED)
                await self._notify(
                    f"{task.id} “{task.title}” needs a decision from you: "
                    f"{result.summary[:160]}"
                )
                return
            if result.status == "blocked":
                # Capture the ground truth BEFORE the worktree is gone, so the
                # operator judges the agent's question against real git state.
                ctx = await asyncio.to_thread(_blocked_context, task, wt)
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._blocked_questions[task.id] = result.summary
                self.log.emit(
                    "blocked", task=task.id, question=result.summary, context=ctx
                )
                self._set_state(task, TaskState.BLOCKED)
                await self._notify(
                    f"{task.id} “{task.title}” is blocked and needs you: "
                    f"{result.summary[:160]}"
                )
                return
            if result.status == "maxturns":
                # The agent ran out of turns but was progressing — resume its session
                # to CONTINUE rather than fail. Capped (max_continuations) so a stuck
                # ticket can't loop forever, and it does NOT consume a retry. With no
                # session to resume, or once the cap is hit, fall through to a normal
                # retryable failure.
                if result.session_id and task.continuations < self.cfg.max_continuations:
                    task.continuations += 1
                    task.resume_session = result.session_id
                    task.failure_notes.append(
                        "You ran out of your turn budget before finishing. Your work is "
                        "intact in the worktree — continue from where you stopped, run "
                        "the success criteria, and finish the ticket."
                    )
                    self._parked_retry[task.id] = wt
                    self.log.emit("continued", task=task.id, n=task.continuations)
                    self._set_state(task, TaskState.QUEUED)
                else:
                    await self._retryable_failure(
                        task, wt, None if task.resume_session else result.session_id,
                        "ran out of turn budget repeatedly without finishing",
                    )
                return
            if result.status in ("timeout", "error"):
                # A resumed attempt that errored again does NOT re-park: the
                # session may be the problem, so the next attempt starts fresh.
                session = None if task.resume_session else result.session_id
                await self._retryable_failure(
                    task, wt, session, f"agent {result.status}: {result.summary}"
                )
                return

            # No-op ticket: the agent EXPLICITLY declared the change already existed
            # ("noop": true) and git confirms it (clean tree, no new commit). Landing
            # nothing is a valid outcome — mark it done and archive, skipping
            # verify/review/merge. This removes the exact pressure that pushed an agent
            # toward a destructive `git reset` to fabricate a commit. A plain done with
            # no commit (no noop claim) is NOT trusted here: it falls through to the
            # verify gate, which fails it with "no commits on the task branch".
            if result.noop and await asyncio.to_thread(_is_noop, task, wt):
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self.log.emit(
                    "noop", task=task.id, summary=result.summary or "already implemented"
                )
                self._set_state(task, TaskState.DONE)
                self._archive_ticket(task)
                return

            if task.skip_verify:
                # Trivial ticket, operator opted out: no verify step (they'll eyeball it).
                self.log.emit("verify", task=task.id, ok=True, skipped=True, failures=[])
            else:
                self._set_state(task, TaskState.VERIFYING)
                verdict = await asyncio.to_thread(
                    run_verify, task, wt.path, self.cfg.verify,
                    _sbx_verify_runner if sandboxed else None,
                )
                self.log.emit(
                    "verify", task=task.id, ok=verdict.ok, failures=list(verdict.failures),
                )
                if not verdict.ok:
                    await self._retryable_failure(
                        task, wt, result.session_id,
                        "verify failed: " + "; ".join(verdict.failures),
                    )
                    return

            if self.cfg.review.enabled:
                if task.skip_review:
                    # Operator opted this ticket out of the AI reviewer — saves a
                    # whole review agent's tokens on a low-risk change.
                    self.log.emit("review", task=task.id, verdict="skipped",
                                  reasons=["reviewer skipped for this ticket"])
                elif not await self._review_gate(task, wt):
                    return

            if self.cfg.manual_approval:
                # Control mode: park the ready branch and wait for the operator.
                base = wt_mod.git(wt.repo, "rev-parse", task.base_branch, check=False)
                head = wt_mod.git(wt.repo, "rev-parse", wt.branch, check=False)
                base_sha = base.stdout.strip()
                head_sha = head.stdout.strip()
                self._awaiting[task.id] = (task, wt)
                # When checkpoints are on, hand the dashboard the per-step commits so
                # a single step can be undone before approval. Off → empty list.
                cps = (
                    checkpoint_mod.list_checkpoints(wt.path, task.base_branch)
                    if self.cfg.agent.checkpoints else []
                )
                self.log.emit(
                    "awaiting_approval", task=task.id, repo=str(task.repo),
                    base=base_sha, commit=head_sha, checkpoints=cps,
                )
                self._set_state(task, TaskState.AWAITING_APPROVAL)
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
        rate_limit_waits = 0
        while True:
            try:
                verdict = await run_review(self.cfg, task, wt.path, log_path)
            except ReviewError as exc:
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._retry_or_fail(task, f"review infrastructure error: {exc}")
                return False
            if not verdict.rate_limited:
                break
            # Each re-review is a full pass (25-turn agent + 60k-char diff). On a
            # bad rate-limit day an uncapped loop would re-pay that indefinitely
            # for ONE ticket — after two waits, fail open: the work already passed
            # the deterministic verify gate, so merge it and say so loudly.
            rate_limit_waits += 1
            if rate_limit_waits > 2:
                self.log.emit(
                    "review", task=task.id, verdict="approve",
                    reasons=["fail-open: rate limit persisted through 2 review retries; "
                             "merged on the verify gate alone"],
                )
                return True
            self._trigger_pause()
            if self._stopped:
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._set_state(task, TaskState.QUEUED)  # intact for a later run
                return False
            await asyncio.sleep(max(self._pause_until - time.monotonic(), 1.0))

        self.log.emit("review", task=task.id, verdict=verdict.verdict,
                      reasons=list(verdict.reasons))
        if verdict.verdict != "approve":
            # Park + resume: the agent's commits stand, so it addresses the
            # reviewer's reasons in context instead of rebuilding from scratch.
            await self._retryable_failure(
                task, wt, task.last_session,
                "review rejected: " + "; ".join(verdict.reasons),
            )
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
                if self.cfg.pr.enabled:
                    pr = await asyncio.to_thread(merge_mod.deliver_pr, task, wt, self.cfg.verify)
                    if pr.ok:
                        self.log.emit("pr_opened", task=task.id, repo=str(task.repo), url=pr.url)
                        self._set_state(task, TaskState.DONE)
                        self._archive_ticket(task)
                    else:
                        await self._retryable_failure(task, wt, task.last_session, pr.reason)
                    continue
                result = await asyncio.to_thread(
                    merge_mod.merge_branch, task, wt, self.cfg.verify
                )
                if result.ok:
                    self.log.emit(
                        "merged", task=task.id, branch=wt.branch, repo=str(task.repo),
                        base=result.base_sha, commit=result.head_sha,
                        reverified=result.reverified,
                        **({"warning": result.warning} if result.warning else {}),
                    )
                    # Record the landing on the bus: its files and newly-exported
                    # symbols become world-model truth for the next agent (this is
                    # what stops a sibling redefining a type that now exists).
                    await asyncio.to_thread(
                        self._record_landing, task, result.base_sha, result.head_sha
                    )
                    self._merged_repos.add(task.repo)
                    self._set_state(task, TaskState.DONE)
                    self._archive_ticket(task)
                else:
                    await self._retryable_failure(task, wt, task.last_session, result.reason)
            except Exception as exc:  # noqa: BLE001
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._fail(task, f"internal merge error: {exc!r}")
            finally:
                self._merge_q.task_done()
