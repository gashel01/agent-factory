"""Run Agent Factory's per-ticket pipeline over one SWE-bench instance.

The whole point of the benchmark is the ABLATION: the same coding agent, run
(a) bare, (b) with the adversarial review + resume-retry loop. If the pipeline
adds resolved instances over the bare agent, that delta is Agent Factory's own
contribution — separate from the base model's strength. So this reuses the real
`run_agent` / `run_review` primitives; the configs below just toggle which
stages run.

We never show the agent the hidden tests (that would be cheating): it gets the
repo at `base_commit` and the problem statement, nothing else. The output is a
`model_patch` (unified diff vs base_commit) in the format the official SWE-bench
evaluator consumes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from factory.agent import DEFAULT_CONTRACT, run_agent
from factory.config import Config
from factory.review import run_review
from factory.task import Budget, Task
from factory.worktree import git

from .dataset import Instance


@dataclass(frozen=True)
class AblationConfig:
    """One point in the ablation. `review`/`retries` are the levers that isolate
    the pipeline's contribution; `verify_cmd` is an optional regression guard
    (the repo's own suite) — empty by default since hidden tests are off-limits."""

    name: str
    review: bool = False
    retries: int = 0
    verify_cmd: str = ""


ABLATION: dict[str, AblationConfig] = {
    # Just the agent, one shot — the base model's raw ability. The floor.
    "bare": AblationConfig("bare", review=False, retries=0),
    # + adversarial review of the diff and resume-retry on a weak patch. No
    # hidden tests; the reviewer judges the diff against the problem statement.
    "review": AblationConfig("review", review=True, retries=2),
}


@dataclass
class InstanceResult:
    instance_id: str
    config: str
    model_patch: str
    attempts: int
    wall_s: float
    cost_usd: float
    status: str  # produced | empty | error
    notes: list[str] = field(default_factory=list)

    def prediction(self, model_name: str) -> dict:
        """The line the official evaluator reads."""
        return {
            "instance_id": self.instance_id,
            "model_name_or_path": model_name,
            "model_patch": self.model_patch,
        }


# ------------------------------------------------------------------- repo setup

def ensure_clone(instance: Instance, cache_dir: Path) -> Path:
    """A cached full clone per repo (reused across instances of the same repo).
    Cloning Django once and branching per instance beats re-cloning 30 times."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / instance.repo.replace("/", "__")
    if not (dest / ".git").exists():
        git(cache_dir, "clone", f"https://github.com/{instance.repo}.git", str(dest))
    return dest


def checkout_instance(clone: Path, instance: Instance, work_root: Path) -> Path:
    """A fresh worktree at the instance's base_commit, on its own branch so the
    agent can commit and we can diff base..HEAD. Mirrors the factory's own
    git-worktree isolation."""
    work_root.mkdir(parents=True, exist_ok=True)
    wt = work_root / instance.instance_id
    branch = f"sweb/{instance.instance_id}"
    git(clone, "worktree", "add", "-f", "-B", branch, str(wt), instance.base_commit)
    return wt


def extract_patch(wt: Path, base_commit: str) -> str:
    """The agent's changes as a unified diff vs base_commit — committed or not.
    We stage everything and diff against base so a patch is captured even if the
    agent forgot to commit (the bare config doesn't force a commit)."""
    git(wt, "add", "-A")
    # A diff of the index against base captures staged + newly-added files without
    # needing a commit; already-committed work is included via the tree compare.
    diff = git(wt, "diff", base_commit, check=False)
    return diff.stdout


def cleanup_worktree(clone: Path, wt: Path, instance: Instance) -> None:
    git(clone, "worktree", "remove", "--force", str(wt), check=False)
    git(clone, "branch", "-D", f"sweb/{instance.instance_id}", check=False)


# ------------------------------------------------------------------- one instance

def _ticket(instance: Instance, wt: Path, ablation: AblationConfig, timeout_min: int) -> Task:
    body = instance.problem_statement
    if instance.hints_text:
        body += f"\n\n## Hints\n{instance.hints_text}"
    body += (
        "\n\n## Done when\nThe issue described above is fixed in this repository. "
        "Make the change, then commit it."
    )
    return Task(
        id=instance.instance_id,
        title=f"Resolve {instance.instance_id}",
        repo=wt,
        base_branch=instance.base_commit,
        body=body,
        path=wt / f"{instance.instance_id}.md",
        verify_commands=(ablation.verify_cmd,) if ablation.verify_cmd else (),
        budget=Budget(timeout_min=timeout_min),
        max_retries=ablation.retries,
    )


async def run_instance(
    cfg: Config,
    instance: Instance,
    clone: Path,
    work_root: Path,
    ablation: AblationConfig,
    logs_dir: Path,
    timeout_min: int = 30,
) -> InstanceResult:
    """Run the pipeline for one instance and return its patch + telemetry.

    The retry loop mirrors the dispatcher's resume-retry (a failed attempt is
    re-run with `--resume` in the same worktree) but standalone: the benchmark
    has no merge queue, and we submit the patch regardless of the review verdict
    on the last attempt — the official evaluator, not the reviewer, is the judge.
    """
    logs_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    cost = 0.0
    attempts = 0
    notes: list[str] = []
    wt: Path | None = None
    try:
        # Checkout is inside the try so a single bad instance (e.g. a Windows
        # long-path checkout failure) is recorded as an error, not a crash that
        # sinks the whole batch through asyncio.gather.
        wt = checkout_instance(clone, instance, work_root)
        task = _ticket(instance, wt, ablation, timeout_min)
        while True:
            attempts += 1
            log = logs_dir / f"{instance.instance_id}.attempt{attempts}.jsonl"
            result = await run_agent(
                cfg.agent, task, wt, DEFAULT_CONTRACT, log, mode=cfg.execution_mode
            )
            cost += result.usage.cost_usd
            if result.status not in ("done",):
                notes.append(f"attempt {attempts}: agent {result.status}")
                if attempts > task.max_retries:
                    break
                task.resume_session = result.session_id
                task.failure_notes.append(f"agent {result.status}: {result.summary}")
                continue
            # Adversarial review (no hidden tests): a rejection sends the agent
            # back to improve the SAME diff, resuming its session.
            if ablation.review:
                verdict = await run_review(
                    cfg, task, wt, logs_dir / f"{instance.instance_id}.review{attempts}.jsonl"
                )
                if verdict.verdict != "approve" and attempts <= task.max_retries:
                    reasons = "; ".join(verdict.reasons)
                    notes.append(f"attempt {attempts}: review rejected — {reasons}")
                    task.resume_session = result.session_id
                    task.failure_notes.append("review rejected: " + reasons)
                    continue
            break
        patch = extract_patch(wt, instance.base_commit)
        status = "produced" if patch.strip() else "empty"
        return InstanceResult(
            instance_id=instance.instance_id, config=ablation.name, model_patch=patch,
            attempts=attempts, wall_s=round(time.monotonic() - started, 1),
            cost_usd=round(cost, 4), status=status, notes=notes,
        )
    except Exception as exc:  # noqa: BLE001 — one bad instance must not sink the run
        notes.append(f"harness error: {exc!r}")
        return InstanceResult(
            instance_id=instance.instance_id, config=ablation.name, model_patch="",
            attempts=attempts, wall_s=round(time.monotonic() - started, 1),
            cost_usd=round(cost, 4), status="error", notes=notes,
        )
    finally:
        if wt is not None:
            cleanup_worktree(clone, wt, instance)
