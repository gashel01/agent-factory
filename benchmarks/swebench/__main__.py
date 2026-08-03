"""CLI: run the SWE-bench harness and write predictions the evaluator consumes.

    uv run python -m benchmarks.swebench run --dataset verified --slice 30 --config review
    uv run python -m benchmarks.swebench run --instances my_slice.jsonl --config bare

Then evaluate with the OFFICIAL harness (Docker) — see benchmarks/swebench/README.md.
The evaluator, not this script, decides resolved/unresolved.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import asdict
from pathlib import Path

from factory.config import load_config

from .dataset import Instance, load_hf, load_local, take_slice
from .harness import ABLATION, InstanceResult, ensure_clone, run_instance


async def _run(args: argparse.Namespace) -> int:
    if args.instances:
        instances = load_local(Path(args.instances))
    else:
        instances = load_hf(args.dataset, args.split)
    ids = args.ids.split(",") if args.ids else None
    instances = take_slice(instances, args.slice, ids)
    if not instances:
        print("no instances selected")
        return 1

    ablation = ABLATION[args.config]
    cfg = load_config(Path(args.config_file) if args.config_file else None)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache)
    work_root = out_dir / "work"
    logs_dir = out_dir / "logs"
    model_name = f"agent-factory-{ablation.name}"

    print(
        f"SWE-bench: {len(instances)} instance(s), config '{ablation.name}' "
        f"(review={ablation.review}, retries={ablation.retries}), "
        f"{args.slots} in parallel, mode={cfg.execution_mode}"
    )

    sem = asyncio.Semaphore(args.slots)
    results: list[InstanceResult] = []

    async def one(inst: Instance) -> None:
        async with sem:
            # Clone/reuse serially-safe: ensure_clone is idempotent per repo.
            clone = await asyncio.to_thread(ensure_clone, inst, cache_dir)
            res = await run_instance(cfg, inst, clone, work_root, ablation, logs_dir, args.timeout)
            results.append(res)
            print(f"  [{len(results)}/{len(instances)}] {inst.instance_id}: "
                  f"{res.status}, {res.attempts} attempt(s), {res.wall_s}s, ${res.cost_usd}")

    await asyncio.gather(*(one(i) for i in instances))

    # Predictions for the official evaluator, and a rich results file for report.py.
    preds = out_dir / f"predictions.{ablation.name}.jsonl"
    with preds.open("w", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps(r.prediction(model_name)) + "\n")
    res_file = out_dir / f"results.{ablation.name}.jsonl"
    with res_file.open("w", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps(asdict(r)) + "\n")

    produced = sum(1 for r in results if r.status == "produced")
    spend = round(sum(r.cost_usd for r in results), 2)
    print(f"\nwrote {preds.name} ({produced}/{len(results)} produced a patch), "
          f"total API-equivalent ${spend}")
    print(f"next: evaluate {preds.name} with the official SWE-bench harness (see README).")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="benchmarks.swebench")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the harness over a dataset slice")
    r.add_argument("--dataset", default="verified", choices=["verified", "lite", "full"])
    r.add_argument("--split", default="test")
    r.add_argument("--instances", help="local JSONL of instances (offline; overrides --dataset)")
    r.add_argument("--slice", type=int, help="take the first N instances (debug)")
    r.add_argument("--ids", help="comma-separated instance_ids to run exactly")
    r.add_argument("--config", default="review", choices=sorted(ABLATION))
    r.add_argument("--config-file", help="factory.yaml for the agent (model, mode, tools)")
    r.add_argument("--slots", type=int, default=4, help="instances in parallel")
    r.add_argument("--timeout", type=int, default=30, help="per-instance minutes")
    r.add_argument("--cache", default=".swebench-cache", help="repo clone cache")
    r.add_argument("--out", default="swebench-out", help="output directory")

    args = p.parse_args()
    if args.cmd == "run":
        return asyncio.run(_run(args))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
