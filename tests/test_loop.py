"""Autopilot loop guardrails — proven end-to-end with the stub agent, zero tokens.

Every stop condition (success, budget, forecast-gate, max-iterations) is exercised
here, and each test asserts the base branch is NEVER touched: the loop's work lives
on its integration branch, waiting for the human's merge.
"""

from __future__ import annotations

import asyncio

from conftest import git
from factory.loop import LoopSpec, run_loop
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
