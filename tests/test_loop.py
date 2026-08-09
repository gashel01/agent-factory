"""Autopilot loop guardrails — proven end-to-end with the stub agent, zero tokens.

Every stop condition (success, budget, forecast-gate, max-iterations) is exercised
here, and each test asserts the base branch is NEVER touched: the loop's work lives
on its integration branch, waiting for the human's merge.
"""

from __future__ import annotations

import asyncio

from conftest import git, write_ticket
from factory.loop import LoopSpec, _self_goal, run_loop
from test_e2e import make_config

# The stub planner returns loop-friendly tickets (no verify) when it sees this.
OBJECTIVE = "STUB:LOOP produce the outputs"
# Acceptance passes once the tickets have committed their output files onto the
# integration branch; the stub agent commits output_<id>.txt per ticket.
ACCEPT_OK = 'python -c "import glob,sys; sys.exit(0 if glob.glob(\'output_*.txt\') else 1)"'
ACCEPT_NEVER = 'python -c "import sys; sys.exit(1)"'


def _loop(repo, runs, **kw):
    spec = LoopSpec(objective=OBJECTIVE, name="t", **kw)
    return asyncio.run(run_loop(make_config(), spec, repo, runs))


def test_loop_stops_on_success_and_leaves_base_untouched(tmp_path, repo):
    head_before = git(repo, "rev-parse", "main").strip()
    result = _loop(repo, tmp_path / "runs", accept_cmd=ACCEPT_OK, max_iterations=5)
    assert result["stop"] == "success"
    assert result["accepted"] is True
    assert result["base_untouched"] is True
    # main is byte-for-byte where it was; the work is on the integration branch.
    assert git(repo, "rev-parse", "main").strip() == head_before
    assert "warden/loop-t" in git(repo, "branch", "--list", "warden/loop-t")


def test_loop_stops_at_the_budget_cap(tmp_path, repo):
    # Each stub agent costs $1; two tickets/iteration => $2 after iteration 1, which
    # is >= the $1.5 cap, so iteration 2 stops before spending more.
    result = _loop(repo, tmp_path / "runs", accept_cmd=ACCEPT_NEVER, budget_usd=1.5,
                   max_iterations=5)
    assert result["stop"] == "budget"
    assert result["spent"] >= 1.5
    assert result["base_untouched"] is True


def test_loop_forecast_gate_stops_before_overspending(tmp_path, repo):
    # Cap $3: iteration 1 spends $2 (< 3, so the plain check passes). Iteration 2's
    # forecast (median $1 x 2 tickets = $2) would bring it to $4 > $3, so it stops
    # WITHOUT running — spend stays at $2.
    result = _loop(repo, tmp_path / "runs", accept_cmd=ACCEPT_NEVER, budget_usd=3.0,
                   max_iterations=5)
    assert result["stop"] == "budget_forecast"
    assert result["spent"] == 2.0
    assert result["base_untouched"] is True


def test_loop_stops_at_max_iterations(tmp_path, repo):
    result = _loop(repo, tmp_path / "runs", accept_cmd=ACCEPT_NEVER, budget_usd=None,
                   max_iterations=2)
    assert result["stop"] == "max_iterations"
    assert result["accepted"] is False
    assert result["base_untouched"] is True


def test_loop_relocates_runs_out_of_the_repo(tmp_path, repo):
    # --runs pointing INSIDE the repo (not gitignored) would dirty the tree and
    # fail the preflight; the loop relocates it and still succeeds, tree stays clean.
    spec = LoopSpec(objective=OBJECTIVE, accept_cmd=ACCEPT_OK, name="reloc")
    result = asyncio.run(run_loop(make_config(), spec, repo, repo / "runs"))
    assert result["stop"] == "success"
    assert git(repo, "status", "--porcelain").strip() == ""   # repo not dirtied
    assert not (repo / "runs").exists()                        # nothing written inside


def test_loop_backlog_mode_drains_a_backlog(tmp_path, repo):
    # Backlog mode runs an existing backlog under the guardrails (no planning
    # spend), stops "dry" once drained, and archives the done tickets.
    src = tmp_path / "src-backlog"
    write_ticket(src, "001", repo, files_hint="[output_001.txt]")
    write_ticket(src, "002", repo, files_hint="[output_002.txt]")
    spec = LoopSpec(objective="", mode="backlog", source_backlog=src, name="bl",
                    budget_usd=5.0, max_iterations=4)
    result = asyncio.run(run_loop(make_config(), spec, repo, tmp_path / "runs"))
    assert result["stop"] == "dry"
    assert result["base_untouched"] is True
    assert len(list((src / "done").glob("*.md"))) == 2   # both merged and archived


def test_loop_supervisor_mode_decomposes_then_completes(tmp_path, repo):
    # Supervisor mode: the decomposer proposes a concrete objective while nothing
    # has landed, lands a round of work on the integration branch, then declares
    # the mission complete -> the loop stops (dry). Base stays untouched.
    spec = LoopSpec(objective="modernize the greeting", mode="supervisor", name="sup",
                    budget_usd=5.0, max_iterations=4, dry_cap=1)
    result = asyncio.run(run_loop(make_config(), spec, repo, tmp_path / "runs"))
    assert result["stop"] == "dry"
    assert result["base_untouched"] is True
    landed = int(git(repo, "rev-list", "--count", "main..warden/loop-sup").strip())
    assert landed >= 1   # a decomposed round really merged onto the branch


def test_loop_reads_a_live_objective_edit(tmp_path, repo):
    # Live re-steer: objective.md pre-seeded different from the spec objective (as a
    # UI steer would) is read at the top of the round and emits a "steered" event.
    from factory.events import EventLog
    runs = tmp_path / "runs"
    (runs / "loop-steer").mkdir(parents=True)
    (runs / "loop-steer" / "objective.md").write_text("STUB:LOOP steered goal", encoding="utf-8")
    spec = LoopSpec(objective="STUB:LOOP original", accept_cmd=ACCEPT_OK, name="steer")
    asyncio.run(run_loop(make_config(), spec, repo, runs))
    events = list(EventLog.replay(runs / "loop-steer" / "loop.jsonl"))
    assert any(e["event"] == "steered" for e in events)


def test_self_goal_targets_top_hotspot_or_none(tmp_path, repo):
    # Self mode's work-picker: nothing to do on a tiny repo; once a file is big
    # enough to be a hotspot, it becomes the round's split objective.
    assert _self_goal(repo) is None
    (repo / "huge.py").write_text("x = 1\n" * 12000, encoding="utf-8")   # ~72 KB
    git(repo, "add", "huge.py")
    git(repo, "commit", "-m", "add a big file")
    goal = _self_goal(repo)
    assert goal is not None and "huge.py" in goal
