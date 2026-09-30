"""The dispatcher: schedules tasks into slots, enforces budgets, survives rate limits.

Design rules (see AGENT_FACTORY.md):
- `max_slots` is a user parameter with no hard ceiling; the rate-limit handler is
  the real safety net (global pause + exponential backoff, task requeued intact).
- Anti-collision: two tasks whose files_hint overlap never run at the same time.
- Retries re-inject the failure evidence into the ticket; a rate-limit kill is not
  a retry (the task did nothing wrong).

One ticket's attempt runs through explicit phases, each its own method:
  _open_worktree → _run_agent_on → _handle_agent_result → _verify_gate →
  _review_gate → _land (approval park or merge queue).
Best-of-N (`candidates`) fans the first two phases out over N worktrees and
feeds the winner into the same pipeline.
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
from .review import INCONCLUSIVE, ReviewError, ReviewResult, run_review
from .task import IN_FLIGHT, Task, TaskState, TicketError
from .verify import CommandRunner, VerifyResult, run_integration, run_verify

#: Margin added to the CLI's own reset time before relaunching after a rate limit.
_RESET_MARGIN_S = 30


def _box_runner(wt: wt_mod.Worktree, *, tag: str, allow_network: bool) -> CommandRunner:
    """A command runner that executes inside the sandbox against this worktree.

    Setup (trusted operator config) gets network for dependency installs; verify
    (the agent's OWN code — its tests) runs offline, so a gamed or malicious test
    can neither exfiltrate nor reach the network. Neither mounts the auth token.
    The worktree's `.git` pointer is restored after every command: the box could
    write it, and the host runs git there next.
    """
    def run(cmd: str, cwd: Path, timeout_s: int) -> tuple[int, str]:
        box = sandbox_mod.box_for(wt, tag=tag)
        try:
            return sandbox_mod.run_command(
                cmd, cwd, allow_network=allow_network, timeout_s=timeout_s, box=box,
            )
        finally:
            wt_mod.sanitize_gitlink(wt)
    return run


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


def _diff_size(task: Task, wt: wt_mod.Worktree) -> int:
    """Lines added + removed by this branch — the best-of-N tie-breaker (among
    candidates that all pass, the smallest change is the least risky)."""
    out = wt_mod.git(
        wt.path, "diff", "--numstat", f"{task.base_branch}...HEAD", check=False
    ).stdout
    total = 0
    for line in out.splitlines():
        added, _, rest = line.partition("\t")
        removed = rest.partition("\t")[0]
        total += int(added) if added.isdigit() else 0
        total += int(removed) if removed.isdigit() else 0
    return total


def _fresh_log(path: Path) -> Path:
    """Keep every attempt's transcript: move an existing log aside as
    `<name>.attempt<N>.jsonl` before a new attempt writes to the canonical path
    (the one the dashboard tails)."""
    if path.exists():
        stem = path.name.removesuffix(".jsonl")
        n = 1
        while (archived := path.with_name(f"{stem}.attempt{n}.jsonl")).exists():
            n += 1
        with suppress(OSError):
            path.rename(archived)
    return path


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
        # Slots each active ticket occupies (best-of-N candidates count one each).
        self._slots: dict[str, int] = {}
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
        # Every worktree a ticket's worker currently holds (one, or N candidates),
        # so a kill mid-phase cleans up all of them.
        self._held: dict[str, list[wt_mod.Worktree]] = {}
        # Repos that received at least one merge this run — the integration check
        # runs the full suite on each once everything has landed.
        self._merged_repos: set[Path] = set()
        # Since when the run has had nothing to do but wait for an operator answer
        # on a BLOCKED ticket that queued tickets depend on (None = not waiting).
        self._blocked_wait_since: float | None = None

    # ---------------------------------------------------------------- helpers

    @property
    def _sandboxed(self) -> bool:
        return self.cfg.isolation == "sandbox"

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

    def _verify_runner(self, wt: wt_mod.Worktree) -> CommandRunner | None:
        return _box_runner(wt, tag="verify", allow_network=False) if self._sandboxed else None

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

    async def _discard(self, task: Task, wt: wt_mod.Worktree) -> None:
        """Remove a worktree + branch this worker holds, and forget it. Off-thread:
        a slow `git worktree remove` (Windows/AV file locks) must not stall the loop."""
        held = self._held.get(task.id, [])
        if wt in held:
            held.remove(wt)
        await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)

    def _release(self, task: Task, wt: wt_mod.Worktree) -> None:
        """Hand a worktree over to another owner (parked, awaiting, merge queue):
        the worker no longer cleans it up if it is cancelled."""
        held = self._held.get(task.id, [])
        if wt in held:
            held.remove(wt)

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
            self._release(task, wt)
            self._parked_retry[task.id] = wt
        else:
            task.resume_session = None
            await self._discard(task, wt)

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

    def _trigger_pause(self, resets_at: object = None) -> None:
        """Pause launches after a rate limit.

        One EPISODE counts once: with N slots, the N agents that hit the same
        limit all land here, and counting each used to exhaust the stop threshold
        in a single episode. When the CLI says when the plan window resets, wait
        for exactly that (plus a margin) instead of guessing with backoff — unless
        it is further than ratelimit.max_wait_min (a weekly cap): then stop
        cleanly, backlog intact, rather than idle for days.
        """
        now = time.monotonic()
        if now < self._pause_until:
            return  # already paused for this episode
        self._pause_count += 1
        if self._pause_count > self.cfg.ratelimit.max_pauses_before_stop:
            self._stopped = True
            self.log.emit("stopped", reason="rate limit persisted; weekly quota likely exhausted")
            return
        cooldown_s = self.cfg.ratelimit.cooldown_min * 60 * 2 ** (self._pause_count - 1)
        try:
            until_reset = float(resets_at) - time.time() if resets_at is not None else None
        except (TypeError, ValueError):
            until_reset = None
        if until_reset is not None and until_reset > 0:
            if until_reset > self.cfg.ratelimit.max_wait_min * 60:
                self._stopped = True
                self.log.emit(
                    "stopped",
                    reason=f"plan limit resets in {until_reset / 3600:.1f} h — beyond "
                           f"ratelimit.max_wait_min; the backlog is intact for a later run",
                )
                return
            cooldown_s = until_reset + _RESET_MARGIN_S
        self._pause_until = now + cooldown_s
        self.log.emit("paused_ratelimit", pause_n=self._pause_count, cooldown_s=int(cooldown_s))

    def _rate_limit_cleared(self) -> None:
        """A successful agent call ends the rate-limit streak: the next episode is
        a fresh one, not the 7th strike of a run that has long recovered."""
        self._pause_count = 0

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

    # ------------------------------------------------------------ scheduling

    def _in_flight_tasks(self) -> list[Task]:
        return [t for t in self.tasks if self.state[t.id] in IN_FLIGHT]

    def _waits_on_blocked(self, task: Task, _seen: frozenset[str] = frozenset()) -> bool:
        """True when this queued ticket (transitively) depends on a BLOCKED one —
        i.e. it can still run once the operator answers."""
        for dep_id in task.depends_on:
            if dep_id in _seen:
                continue
            dep_state = self.state[dep_id]
            if dep_state is TaskState.BLOCKED:
                return True
            if dep_state is TaskState.QUEUED and self._waits_on_blocked(
                self.by_id[dep_id], _seen | {task.id}
            ):
                return True
        return False

    def _next_eligible(self) -> Task | None:
        in_flight = self._in_flight_tasks()
        queued = sorted(
            (t for t in self.tasks if self.state[t.id] is TaskState.QUEUED),
            key=lambda t: (t.priority, t.id),
        )
        for t in queued:
            # Only a FAILED dependency is final. A BLOCKED one is waiting for the
            # operator's answer — its dependents wait with it instead of failing.
            dead = [d for d in t.depends_on if self.state[d] is TaskState.FAILED]
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

    def _slots_used(self) -> int:
        return sum(self._slots.get(tid, 1) for tid in self._active)

    def _candidates_for(self, task: Task, free_slots: int) -> int:
        """How many parallel candidates this launch gets: best-of-N only on a
        ticket's FIRST attempt (a retry resumes one agent with evidence; an
        adopted branch continues one line of work), capped by free slots."""
        wanted = task.candidates or self.cfg.candidates
        first_try = (
            task.attempts == 0 and task.continuations == 0 and not task.resume_session
            and task.id not in self._parked_retry and not task.adopt_branch
        )
        if not first_try or wanted <= 1:
            return 1
        return max(1, min(wanted, free_slots))

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
            isolation=self.cfg.isolation,
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
            self.log.emit("run_end", counts=dict(counts), stopped=self._stopped,
                          spent_usd=round(self._spent_usd, 4))
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
            result = await asyncio.to_thread(self._integration_for, repo)
            self.log.emit(
                "integration", repo=str(repo), ok=result.ok,
                failures=list(result.failures)[:20],
            )

    def _integration_for(self, repo: Path) -> VerifyResult:
        """Direct mode: at the repo root, as before. Sandbox mode: this is merged
        AGENT code, so it runs in the box — against a scratch checkout of the base
        (the operator's own checkout, with its real `.git`, never enters a box)."""
        if not self._sandboxed:
            return run_integration(repo, self.cfg.integration)
        base = next(t.base_branch for t in self.tasks if t.repo == repo)
        wt = wt_mod.create(repo, self.run_dir / "wt", self.run_id, "integration", base)
        try:
            if self.cfg.setup.commands:
                wt_mod.run_setup(
                    wt.path, self.cfg.setup.commands, self.cfg.setup.timeout_s,
                    _box_runner(wt, tag="setup", allow_network=True),
                )
            return run_integration(
                repo, self.cfg.integration,
                _box_runner(wt, tag="integration", allow_network=False), cwd=wt.path,
            )
        except wt_mod.SetupError as exc:
            return VerifyResult(ok=False, failures=(f"integration setup failed: {exc}",))
        finally:
            wt_mod.remove(wt, delete_branch=True)

    async def _schedule_loop(self) -> None:
        while self._unfinished():
            await self._poll_control()
            self._active = {k: v for k, v in self._active.items() if not v.done()}
            self._slots = {k: v for k, v in self._slots.items() if k in self._active}
            now = time.monotonic()

            if self._stopped and not self._active and self._merge_q.empty():
                break

            paused = self._manual_pause or now < self._pause_until
            free = self.cfg.max_slots - self._slots_used()
            can_launch = (
                not paused
                and not self._stopped
                and free > 0
                and now >= self._next_launch_at
            )
            if can_launch and (task := self._next_eligible()):
                # State flips SYNCHRONOUSLY here, not inside the worker coroutine:
                # eligibility must never depend on whether the worker got scheduled
                # yet, or the same task is re-selected in a tight loop that starves
                # the event loop (bug found by faulthandler on 2026-07-11).
                self._blocked_wait_since = None
                n = self._candidates_for(task, free)
                self._set_state(task, TaskState.RUNNING)
                self._slots[task.id] = n
                self._active[task.id] = asyncio.create_task(self._worker(task, n))
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
            waiting = [t for t in queued if self._waits_on_blocked(t)]
            if merging:
                await asyncio.sleep(0.2)
            elif self._awaiting:
                # Control mode: tasks are parked waiting for your approval. Keep the
                # run alive and control-responsive — and never call a queued task
                # "unsatisfiable" when its dependency is only waiting to be approved.
                await asyncio.sleep(0.3)
            elif queued and (paused or now < self._next_launch_at):
                await asyncio.sleep(min(1.0, max(self._next_launch_at - now, 0.1)))
            elif waiting and len(waiting) == len(queued):
                await self._wait_for_answers(waiting, now)
            elif queued:
                # Nothing active, nothing launchable: the remaining graph is unsatisfiable.
                for t in queued:
                    self._fail(t, "unsatisfiable dependencies (circular or all deps failed)")
            else:
                break

    async def _wait_for_answers(self, waiting: list[Task], now: float) -> None:
        """Everything left depends on a BLOCKED ticket: keep the run alive (and
        control-responsive) so an answer from the dashboard can unblock the chain —
        for up to concurrency.blocked_wait_min, after which the dependents are left
        for a later run, with that reason, instead of hanging forever."""
        if self._blocked_wait_since is None:
            self._blocked_wait_since = now
            self.log.emit("waiting_on_operator", tasks=[t.id for t in waiting],
                          minutes=self.cfg.blocked_wait_min)
            await self._notify(
                f"{len(waiting)} ticket(s) are waiting on a blocked ticket — answer it "
                f"to let them run."
            )
        if now - self._blocked_wait_since < self.cfg.blocked_wait_min * 60:
            await asyncio.sleep(0.5)
            return
        for t in waiting:
            self._fail(t, "still waiting on a blocked ticket when the run's wait ended "
                          "— left in the backlog for the next run")

    # ---------------------------------------------------------------- worker

    async def _worker(self, task: Task, candidates: int = 1) -> None:
        # State is already RUNNING — set by the scheduler at launch time.
        self._held[task.id] = []
        try:
            if candidates > 1:
                await self._run_candidates(task, candidates)
            else:
                await self._single_attempt(task)
        except asyncio.CancelledError:
            # Deliberate operator kill (dashboard) or run shutdown. Absorbing the
            # cancellation is intentional: the worker cleans up and records a
            # terminal state.
            for wt in list(self._held.get(task.id, [])):
                await asyncio.shield(asyncio.to_thread(wt_mod.remove, wt, delete_branch=True))
            self._fail(task, "killed by the operator")
        except Exception as exc:  # noqa: BLE001 — a worker must never take down the run
            for wt in list(self._held.get(task.id, [])):
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
            self._fail(task, f"internal worker error: {exc!r}")
        finally:
            self._held.pop(task.id, None)

    async def _single_attempt(self, task: Task) -> None:
        # A parked worktree from a retryable failure is reused as-is: the agent
        # resumes its session there, and setup is already done (both are paid
        # only once per task, not once per attempt).
        parked = self._parked_retry.pop(task.id, None)
        wt = await self._open_worktree(task, parked)
        if wt is None:
            return
        log_path = _fresh_log(self.run_dir / "agents" / f"{task.id}.stdout.jsonl")
        result = await self._run_agent_on(task, wt, log_path)
        await self._handle_agent_result(task, wt, result)

    async def _open_worktree(
        self, task: Task, parked: wt_mod.Worktree | None, suffix: str = ""
    ) -> wt_mod.Worktree | None:
        """A ready worktree for this attempt — parked (resume) or fresh (created,
        sandbox infra up, setup run). None when the task failed getting there."""
        if parked is not None:
            self._held[task.id].append(parked)
            return parked
        task.resume_session = None  # fresh worktree ⇒ a resume would desync
        adopt = task.adopt_branch
        try:
            wt = await asyncio.to_thread(
                wt_mod.create, task.repo, self.run_dir / "wt", self.run_id,
                f"{task.id}{suffix}", task.base_branch, start_point=adopt,
            )
        except wt_mod.GitError as exc:
            self._fail(task, f"worktree creation failed: {exc}")
            return None
        self._held[task.id].append(wt)
        if adopt:
            # The recovered commits now live on this attempt's branch: drop the old
            # ref, and tell the agent it is continuing interrupted work.
            task.adopt_branch = None
            await asyncio.to_thread(wt_mod.git, task.repo, "branch", "-D", adopt, check=False)
            task.failure_notes.append(
                "A previous run was interrupted while working on this ticket. Its "
                "commits are already on your branch — read them (git log, git diff "
                f"{task.base_branch}...HEAD), then continue from there."
            )
            self.log.emit("adopted", task=task.id, branch=adopt)
        if self._sandboxed:
            # Bring the isolation infra up ONCE before setup/agent/verify (all
            # run in the box). Fails the task early with an actionable message
            # if Docker or the image isn't ready, instead of deep in a phase.
            try:
                await asyncio.to_thread(sandbox_mod.ensure_infra)
            except sandbox_mod.SandboxError as exc:
                await self._discard(task, wt)
                self._fail(task, f"sandbox unavailable: {exc}")
                return None
        if self.cfg.setup.commands:
            try:
                await asyncio.to_thread(
                    wt_mod.run_setup, wt.path, self.cfg.setup.commands,
                    self.cfg.setup.timeout_s,
                    _box_runner(wt, tag="setup", allow_network=True) if self._sandboxed
                    else None,
                )
                self.log.emit("setup", task=task.id, ok=True)
            except wt_mod.SetupError as exc:
                self.log.emit("setup", task=task.id, ok=False, reason=str(exc)[:500])
                await self._discard(task, wt)
                # Environment problem, not agent failure: retrying without a
                # config fix would burn attempts for nothing.
                self._fail(task, f"worktree setup failed: {exc}")
                return None
        return wt

    async def _run_agent_on(
        self, task: Task, wt: wt_mod.Worktree, log_path: Path
    ) -> agent_mod.AgentResult:
        """One agent pass on a worktree: prompt layers, the agent itself (in the box
        when sandboxed, its commits imported back), cost + progress events."""
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

        box = None
        if self._sandboxed:
            box = await asyncio.to_thread(
                sandbox_mod.box_for, wt, tag="agent",
                out_dir=self.run_dir / "sbx" / wt.path.name,
            )
        result = await agent_mod.run_agent(
            self.cfg.agent, task, wt.path, self._contract, log_path, recall.text,
            self._brief_for(task.repo), architecture=self._architecture(),
            on_progress=_progress,
            mode=self.cfg.execution_mode,
            isolation=self.cfg.isolation,
            coordination=coord_text,
            coord_path=self._coord.path,
            box=box,
        )
        if box is not None:
            try:
                await asyncio.to_thread(sandbox_mod.import_result, wt, box)
            except (sandbox_mod.SandboxError, wt_mod.GitError) as exc:
                result = agent_mod.AgentResult(
                    "error", f"could not import the sandboxed agent's commits: {exc}"[:500],
                    result.turns, result.wall_s, None, result.session_id, result.usage,
                )
        u = result.usage
        self._spent_usd += u.cost_usd
        # Remember the session so a later-stage failure (merge conflict,
        # review rejection) can resume this agent rather than restart cold.
        task.last_session = result.session_id
        self.log.emit(
            "agent_result",
            task=task.id,
            attempt=task.attempts,
            worktree=wt.path.name,
            status=result.status,
            turns=result.turns,
            wall_s=round(result.wall_s, 1),
            summary=result.summary,
            session_id=result.session_id,
            cost_usd=round(u.cost_usd, 4),
            input_tokens=u.input_tokens,
            output_tokens=u.output_tokens,
            cache_read_tokens=u.cache_read_tokens,
            cache_write_tokens=u.cache_write_tokens,
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
        if result.status != "ratelimit":
            self._rate_limit_cleared()
        self._enforce_budget()
        return result

    async def _handle_agent_result(
        self, task: Task, wt: wt_mod.Worktree, result: agent_mod.AgentResult,
        *, verified: bool = False,
    ) -> None:
        """Route one agent outcome: pause, park for the operator, continue, retry,
        or carry the work on through verify → review → landing."""
        if result.status == "ratelimit":
            await self._discard(task, wt)
            resets = (result.rate_limit_info or {}).get("resetsAt")
            self._trigger_pause(resets)
            self._set_state(task, TaskState.QUEUED)  # not a retry: task did nothing wrong
            return
        if result.status in ("decision", "blocked"):
            # A decision: the agent reached a genuine fork it must not decide alone
            # and offered concrete options — parked like a block (same answer→resume
            # machinery), but the options let the dashboard render a pick instead of
            # a free-text box. Either way, capture the ground truth BEFORE the
            # worktree is gone, so the operator judges the question against git.
            ctx = await asyncio.to_thread(_blocked_context, task, wt)
            await self._discard(task, wt)
            self._blocked_questions[task.id] = result.summary
            extra: dict = {}
            if result.status == "decision":
                self._pending_decisions[task.id] = result.summary
                extra = {"kind": "decision", "options": list(result.options)}
            self.log.emit("blocked", task=task.id, question=result.summary, context=ctx, **extra)
            self._set_state(task, TaskState.BLOCKED)
            what = "needs a decision from you" if result.status == "decision" \
                else "is blocked and needs you"
            await self._notify(f"{task.id} “{task.title}” {what}: {result.summary[:160]}")
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
                self._release(task, wt)
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
            await self._discard(task, wt)
            self.log.emit(
                "noop", task=task.id, summary=result.summary or "already implemented"
            )
            self._set_state(task, TaskState.DONE)
            self._archive_ticket(task)
            return

        if not verified and not await self._verify_gate(task, wt, result.session_id):
            return
        if self.cfg.review.enabled:
            if task.skip_review:
                # Operator opted this ticket out of the AI reviewer — saves a
                # whole review agent's tokens on a low-risk change.
                self.log.emit("review", task=task.id, verdict="skipped",
                              reasons=["reviewer skipped for this ticket"])
            else:
                outcome = await self._review_gate(task, wt)
                if outcome == "hold":
                    await self._park_for_approval(
                        task, wt, reason="the reviewer could not reach a verdict — "
                                         "your call",
                    )
                    return
                if outcome != "approve":
                    return
        await self._land(task, wt)

    async def _verify_gate(self, task: Task, wt: wt_mod.Worktree, session: str | None) -> bool:
        """The deterministic gate. False = the task was requeued or failed."""
        if task.skip_verify:
            # Trivial ticket, operator opted out: no verify step (they'll eyeball it).
            self.log.emit("verify", task=task.id, ok=True, skipped=True, failures=[])
            return True
        self._set_state(task, TaskState.VERIFYING)
        verdict = await asyncio.to_thread(
            run_verify, task, wt.path, self.cfg.verify, self._verify_runner(wt),
        )
        self.log.emit("verify", task=task.id, ok=verdict.ok, failures=list(verdict.failures))
        if not verdict.ok:
            await self._retryable_failure(
                task, wt, session, "verify failed: " + "; ".join(verdict.failures),
            )
            return False
        return True

    async def _park_for_approval(self, task: Task, wt: wt_mod.Worktree, reason: str = "") -> None:
        """Park the ready branch and wait for the operator (control mode, or a
        review that could not conclude under review.on_failure: hold)."""
        base = wt_mod.git(wt.repo, "rev-parse", task.base_branch, check=False)
        head = wt_mod.git(wt.repo, "rev-parse", wt.branch, check=False)
        self._release(task, wt)
        self._awaiting[task.id] = (task, wt)
        # When checkpoints are on, hand the dashboard the per-step commits so
        # a single step can be undone before approval. Off → empty list.
        cps = (
            checkpoint_mod.list_checkpoints(wt.path, task.base_branch)
            if self.cfg.agent.checkpoints else []
        )
        self.log.emit(
            "awaiting_approval", task=task.id, repo=str(task.repo),
            base=base.stdout.strip(), commit=head.stdout.strip(), checkpoints=cps,
            **({"reason": reason} if reason else {}),
        )
        self._set_state(task, TaskState.AWAITING_APPROVAL)
        if reason:
            await self._notify(f"{task.id} “{task.title}” waits for your approval: {reason}")

    async def _land(self, task: Task, wt: wt_mod.Worktree) -> None:
        if self.cfg.manual_approval:
            await self._park_for_approval(task, wt)
            return
        self._release(task, wt)
        self._set_state(task, TaskState.MERGE_QUEUED)
        self._merge_q.put_nowait((task, wt))

    # ----------------------------------------------------------- best-of-N

    async def _run_candidates(self, task: Task, n: int) -> None:
        """N independent agents on the same ticket, each in its own worktree. The
        verified candidate with the smallest diff goes on to review/landing; the
        rest are discarded. With no passing candidate, the first one is handled
        like a normal single attempt (retry with evidence, blocked, …)."""
        wts: list[wt_mod.Worktree] = []
        for i in range(n):
            wt = await self._open_worktree(task, None, suffix=f"-c{i + 1}")
            if wt is None:
                for other in wts:
                    await self._discard(task, other)
                return
            wts.append(wt)
        self.log.emit("candidates_start", task=task.id, n=n)
        agents_dir = self.run_dir / "agents"
        # Candidate 1 writes to the canonical log (the one the dashboard tails live).
        logs = [_fresh_log(agents_dir / f"{task.id}.stdout.jsonl")] + [
            _fresh_log(agents_dir / f"{task.id}.c{i + 1}.stdout.jsonl") for i in range(1, n)
        ]
        results = await asyncio.gather(
            *(self._run_agent_on(task, wt, log) for wt, log in zip(wts, logs, strict=True))
        )
        if any(r.status == "ratelimit" for r in results):
            for wt in wts[1:]:
                await self._discard(task, wt)
            limited = next(r for r in results if r.status == "ratelimit")
            await self._handle_agent_result(task, wts[0], limited)
            return

        self._set_state(task, TaskState.VERIFYING)
        scored: list[tuple[int, int]] = []  # (diff size, index) of passing candidates
        outcomes: list[dict] = []
        for i, (wt, result) in enumerate(zip(wts, results, strict=True)):
            entry: dict = {"candidate": i + 1, "status": result.status}
            if result.status == "done" and not result.noop:
                verdict = await asyncio.to_thread(
                    run_verify, task, wt.path, self.cfg.verify, self._verify_runner(wt),
                )
                entry["verify"] = verdict.ok
                if verdict.ok:
                    size = await asyncio.to_thread(_diff_size, task, wt)
                    entry["diff_lines"] = size
                    scored.append((size, i))
                else:
                    entry["failures"] = list(verdict.failures)[:3]
            outcomes.append(entry)
        winner = min(scored)[1] if scored else None
        self.log.emit("candidates", task=task.id, outcomes=outcomes,
                      winner=None if winner is None else winner + 1)

        keep = winner if winner is not None else 0
        for i, wt in enumerate(wts):
            if i != keep:
                await self._discard(task, wt)
        if winner is not None and winner != 0:
            # The dashboard shows the canonical log: make it the winner's.
            with suppress(OSError):
                logs[0].rename(agents_dir / f"{task.id}.c1.stdout.jsonl")
                logs[winner].rename(logs[0])
        if winner is not None:
            self.log.emit("verify", task=task.id, ok=True, failures=[],
                          candidate=winner + 1)
            task.last_session = results[winner].session_id
        await self._handle_agent_result(
            task, wts[keep], results[keep], verified=winner is not None,
        )

    # --------------------------------------------------------------- review

    async def _review_gate(self, task: Task, wt: wt_mod.Worktree) -> str:
        """Adversarial review of the diff: "approve", "rejected" (task requeued or
        failed), "hold" (inconclusive, the operator decides) or "stopped".

        A review that cannot conclude is retried (review.attempts), then handled
        per review.on_failure — never silently approved unless the operator chose
        that. A rate limit waits out the global pause and reviews again.
        """
        self._set_state(task, TaskState.REVIEWING)
        log_path = self.run_dir / "agents" / f"{task.id}.review.jsonl"
        tries = 0
        while True:
            try:
                verdict = await run_review(self.cfg, task, wt.path, _fresh_log(log_path))
            except ReviewError as exc:
                verdict = ReviewResult(INCONCLUSIVE, (f"review infrastructure error: {exc}",))
            self._spent_usd += verdict.cost_usd
            if verdict.rate_limited:
                self._trigger_pause()
                if self._stopped:
                    await self._discard(task, wt)
                    self._set_state(task, TaskState.QUEUED)  # intact for a later run
                    return "stopped"
                await asyncio.sleep(max(self._pause_until - time.monotonic(), 1.0))
                continue
            if verdict.verdict != INCONCLUSIVE:
                break
            tries += 1
            if tries >= self.cfg.review.attempts:
                break
            self.log.emit("review_retry", task=task.id, reasons=list(verdict.reasons))

        self._enforce_budget()
        self.log.emit("review", task=task.id, verdict=verdict.verdict,
                      reasons=list(verdict.reasons), cost_usd=round(verdict.cost_usd, 4))
        outcome = verdict.verdict
        if outcome == INCONCLUSIVE:
            policy = self.cfg.review.on_failure
            self.log.emit("review_inconclusive", task=task.id, policy=policy)
            if policy == "approve":
                return "approve"
            if policy == "hold":
                return "hold"
            outcome = "reject"
        if outcome != "approve":
            # Park + resume: the agent's commits stand, so it addresses the
            # reviewer's reasons in context instead of rebuilding from scratch.
            await self._retryable_failure(
                task, wt, task.last_session,
                "review rejected: " + "; ".join(verdict.reasons),
            )
            return "rejected"
        return "approve"

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

    # ---------------------------------------------------------------- merge

    async def _merge_worker(self) -> None:
        while True:
            task, wt = await self._merge_q.get()
            try:
                self._set_state(task, TaskState.MERGING)
                runner = self._verify_runner(wt)
                if self.cfg.pr.enabled:
                    pr = await asyncio.to_thread(
                        merge_mod.deliver_pr, task, wt, self.cfg.verify, runner
                    )
                    if pr.ok:
                        self.log.emit("pr_opened", task=task.id, repo=str(task.repo), url=pr.url)
                        self._set_state(task, TaskState.DONE)
                        self._archive_ticket(task)
                    else:
                        await self._merge_setback(task, wt, pr.reason, pr.conflicts)
                    continue
                result = await asyncio.to_thread(
                    merge_mod.merge_branch, task, wt, self.cfg.verify, runner
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
                    await self._merge_setback(task, wt, result.reason, result.conflicts)
            except Exception as exc:  # noqa: BLE001
                await asyncio.to_thread(wt_mod.remove, wt, delete_branch=True)
                self._fail(task, f"internal merge error: {exc!r}")
            finally:
                self._merge_q.task_done()

    async def _merge_setback(
        self, task: Task, wt: wt_mod.Worktree, reason: str, conflicts: tuple[str, ...]
    ) -> None:
        """A branch that could not land. On conflicts with the moved base the
        worktree is left mid-merge and the agent resumes to resolve them (with the
        exact instructions in `reason`); anything else is an ordinary retry."""
        if conflicts:
            self.log.emit("merge_conflict", task=task.id, files=list(conflicts)[:50])
            if not task.last_session:
                # Nobody to resume into the conflict: start clean next time.
                wt_mod.git(wt.path, "merge", "--abort", check=False)
        await self._retryable_failure(task, wt, task.last_session, reason)
