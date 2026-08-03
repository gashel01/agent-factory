"""Aggregate a run into the headline numbers — and, across configs, the ABLATION
DELTA that is Agent Factory's own contribution.

    uv run python -m benchmarks.swebench.report \
        --results swebench-out/results.review.jsonl \
        --evaluation swebench-out/agent-factory-review.json

`--evaluation` is the JSON the official SWE-bench evaluator emits (it lists the
resolved instance ids). Pass two configs to print the delta between them.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def _load_results(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def _resolved_ids(evaluation: Path | None) -> set[str] | None:
    """The official evaluator writes a report with resolved instance ids. Accept
    either {"resolved_ids": [...]} or the full report shape {"resolved": [...]}."""
    if not evaluation or not evaluation.exists():
        return None
    data = json.loads(evaluation.read_text(encoding="utf-8"))
    for key in ("resolved_ids", "resolved", "resolved_instances"):
        if isinstance(data.get(key), list):
            return {str(x) for x in data[key]}
    return None


def summarize(results_path: Path, evaluation: Path | None) -> dict:
    rows = _load_results(results_path)
    resolved = _resolved_ids(evaluation)
    n = len(rows)
    produced = sum(1 for r in rows if r["status"] == "produced")
    spend = round(sum(r["cost_usd"] for r in rows), 2)
    wall = round(sum(r["wall_s"] for r in rows) / n, 1) if n else 0.0
    attempts = round(sum(r["attempts"] for r in rows) / n, 2) if n else 0.0
    out = {
        "config": rows[0]["config"] if rows else "?",
        "instances": n,
        "produced_patch": produced,
        "avg_attempts": attempts,
        "avg_wall_s": wall,
        "total_cost_usd": spend,
    }
    if resolved is not None:
        got = sum(1 for r in rows if r["instance_id"] in resolved)
        out["resolved"] = got
        out["resolve_rate"] = round(got / n, 4) if n else 0.0
    return out


def _print(summary: dict) -> None:
    print(f"\n== {summary['config']} ==")
    print(f"  instances       {summary['instances']}")
    print(f"  produced patch  {summary['produced_patch']}")
    if "resolved" in summary:
        print(f"  RESOLVED        {summary['resolved']}  ({summary['resolve_rate'] * 100:.1f}%)")
    print(f"  avg attempts    {summary['avg_attempts']}")
    print(f"  avg wall        {summary['avg_wall_s']}s")
    print(f"  cost (API-eq)   ${summary['total_cost_usd']}")


def main() -> int:
    p = argparse.ArgumentParser(prog="benchmarks.swebench.report")
    p.add_argument("--results", required=True, help="results.<config>.jsonl from the run")
    p.add_argument("--evaluation", help="official evaluator JSON (resolved ids)")
    p.add_argument("--baseline-results", help="a second config's results, for the delta")
    p.add_argument("--baseline-evaluation", help="its evaluator JSON")
    args = p.parse_args()

    main_sum = summarize(Path(args.results), Path(args.evaluation) if args.evaluation else None)
    _print(main_sum)

    if args.baseline_results:
        base_sum = summarize(
            Path(args.baseline_results),
            Path(args.baseline_evaluation) if args.baseline_evaluation else None,
        )
        _print(base_sum)
        if "resolve_rate" in main_sum and "resolve_rate" in base_sum:
            delta = (main_sum["resolve_rate"] - base_sum["resolve_rate"]) * 100
            print(
                f"\n== ablation delta ==\n"
                f"  {main_sum['config']} vs {base_sum['config']}: "
                f"{delta:+.1f} points resolved "
                f"({base_sum['resolve_rate'] * 100:.1f}% → {main_sum['resolve_rate'] * 100:.1f}%)"
            )
            print("  ^ Agent Factory's pipeline contribution, isolated from the base model.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
