"""SWE-bench instance loading.

A SWE-bench instance is a real GitHub issue: a repo at a fixed commit, a
problem statement, and (hidden from the agent) the tests that decide success.
We only ever hand the agent the repo + the problem statement.

The dataset lives on HuggingFace (`princeton-nlp/SWE-bench_Verified` / `_Lite`);
`datasets` is an optional dependency so the harness imports without it. A local
JSONL slice can stand in for offline runs and tests.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

#: HuggingFace dataset ids, by short name.
HF_DATASETS = {
    "verified": "princeton-nlp/SWE-bench_Verified",
    "lite": "princeton-nlp/SWE-bench_Lite",
    "full": "princeton-nlp/SWE-bench",
}


@dataclass(frozen=True)
class Instance:
    """One SWE-bench task. Only `repo`, `base_commit` and `problem_statement`
    (plus optional hints) are ever shown to the agent — the rest is for the
    official evaluator and must NOT leak into the prompt."""

    instance_id: str
    repo: str  # "django/django"
    base_commit: str
    problem_statement: str
    hints_text: str = ""
    version: str = ""
    environment_setup_commit: str = ""

    @staticmethod
    def from_row(row: dict) -> Instance:
        return Instance(
            instance_id=str(row["instance_id"]),
            repo=str(row["repo"]),
            base_commit=str(row["base_commit"]),
            problem_statement=str(row.get("problem_statement", "")),
            hints_text=str(row.get("hints_text", "") or ""),
            version=str(row.get("version", "") or ""),
            environment_setup_commit=str(row.get("environment_setup_commit", "") or ""),
        )


def load_local(path: Path) -> list[Instance]:
    """Load instances from a JSONL file (one instance object per line)."""
    out: list[Instance] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(Instance.from_row(json.loads(line)))
    return out


def load_hf(name: str, split: str = "test") -> list[Instance]:
    """Load a SWE-bench split from HuggingFace. Requires `datasets` (install the
    `bench` extra). Kept out of import time so the harness works without it."""
    if name not in HF_DATASETS:
        raise ValueError(f"unknown dataset '{name}'; choose from {sorted(HF_DATASETS)}")
    try:
        from datasets import load_dataset  # noqa: PLC0415 — optional dependency
    except ImportError as exc:
        raise RuntimeError(
            "loading a HuggingFace SWE-bench split needs the `datasets` package — "
            "`uv sync --extra bench`, or pass a local JSONL with --instances"
        ) from exc
    ds = load_dataset(HF_DATASETS[name], split=split)
    return [Instance.from_row(row) for row in ds]


def take_slice(instances: list[Instance], n: int | None, ids: list[str] | None) -> list[Instance]:
    """Narrow to an explicit id list, or the first `n` (debug slice). Explicit
    ids win so a run can target exactly the instances you care about."""
    if ids:
        keep = set(ids)
        picked = [i for i in instances if i.instance_id in keep]
        missing = keep - {i.instance_id for i in picked}
        if missing:
            raise ValueError(f"instances not found in the dataset: {sorted(missing)}")
        return picked
    if n is not None:
        return instances[:n]
    return instances
