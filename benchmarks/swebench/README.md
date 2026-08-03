# SWE-bench harness

Measures Agent Factory's resolve rate on real GitHub issues — and, via an
**ablation**, isolates what the *pipeline* adds on top of the base model.

## Why this exists

SWE-bench (real issues from Django, sympy, scikit-learn, …) scores are mostly
determined by the base model + agent scaffolding. Agent Factory runs on Claude
Code, already a strong SWE-bench harness, so a headline score would largely be
Anthropic's credit, not ours. The number that *is* ours is the **delta** our
governance pipeline adds. So we run two configs and report the gap:

| config   | what runs                                             |
|----------|-------------------------------------------------------|
| `bare`   | the agent, one shot — the base model's raw ability    |
| `review` | agent + adversarial review + resume-retry on a weak diff |

The agent only ever sees the repo at `base_commit` + the problem statement — the
hidden tests are never shown to it (that would be cheating).

## Cost, honestly

- **Model inference:** under a Claude **subscription** this is ~$0 in dollars —
  it draws from your plan, bounded by rate limits + wall time, not per-token
  billing. Under **API mode** it's real money: ~$0.3–2 per instance, so a
  30-slice ≈ $10–60, Verified (500) ≈ $150–1000.
- **Evaluation infra:** the official evaluator runs each repo's tests in Docker.
  Images are large — a 30-slice is tens of GB of disk; the full set is hundreds.
  Budget a beefy machine (or a cloud VM) and a few hours. On Windows use WSL2 +
  Docker Desktop (the repos are Linux/Python).

Start with `--slice 30` to debug the harness for ~nothing, then scale.

## 1. Produce patches

```bash
# a cheap debug slice, full pipeline, on your subscription
uv run python -m benchmarks.swebench run \
  --dataset verified --slice 30 --config review \
  --config-file path/to/factory.yaml --slots 4 --out swebench-out

# the baseline, same slice, for the ablation
uv run python -m benchmarks.swebench run \
  --dataset verified --slice 30 --config bare \
  --config-file path/to/factory.yaml --slots 4 --out swebench-out
```

Loading a HuggingFace split needs the `bench` extra (`uv sync --extra bench`).
Offline / reproducible runs can pass a local slice instead:
`--instances my_slice.jsonl` (one instance JSON per line; the same schema as the
HF rows — `instance_id`, `repo`, `base_commit`, `problem_statement`).

Each run writes `predictions.<config>.jsonl` (for the evaluator) and
`results.<config>.jsonl` (telemetry: attempts, wall, cost, notes).

## 2. Evaluate with the OFFICIAL harness

We do **not** grade ourselves — the upstream evaluator does, in Docker:

```bash
python -m pip install swebench          # the official package
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path swebench-out/predictions.review.jsonl \
  --run_id af-review --max_workers 4
# → writes agent-factory-review.<run_id>.json with the resolved instance ids
```

(See the SWE-bench repo for the current exact invocation; the flags move.)

## 3. Report + the ablation delta

```bash
uv run python -m benchmarks.swebench.report \
  --results swebench-out/results.review.jsonl \
  --evaluation agent-factory-review.af-review.json \
  --baseline-results swebench-out/results.bare.jsonl \
  --baseline-evaluation agent-factory-bare.af-bare.json
```

Prints resolve rate + cost for each config and the **delta** — the headline:

```
== ablation delta ==
  review vs bare: +8.3 points resolved (41.7% → 50.0%)
  ^ Agent Factory's pipeline contribution, isolated from the base model.
```

## The claim this supports

Not "we beat Devin" (that would be mostly Claude's score). Instead:
**competitive resolve rate at ~$0 (subscription), with +N points proven to come
from the governance pipeline, not the base model.** That delta is the part
nobody can attribute to Anthropic.
