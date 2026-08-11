"""Adversarial review gate: approve → merge, reject → retry with evidence."""

from __future__ import annotations

from dataclasses import replace

from conftest import git, write_ticket
from factory.config import ReviewConfig
from factory.events import EventLog
from test_e2e import make_config, run_dispatcher


def review_config(**kwargs):
    cfg = make_config(**kwargs)
    return replace(cfg, review=ReviewConfig(enabled=True))


def test_approved_diff_merges(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")

    counts = run_dispatcher(review_config(), backlog, tmp_path / "run")

    assert counts == {"DONE": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    reviews = [e for e in events if e["event"] == "review"]
    assert reviews and reviews[0]["verdict"] == "approve"
    # REVIEWING appeared between verify and merge
    states = [e["to"] for e in events if e["event"] == "state" and e["task"] == "001"]
    assert states.index("REVIEWING") < states.index("MERGE_QUEUED")
    assert "output_001.txt" in git(repo, "ls-tree", "--name-only", "main")


def test_rejected_diff_retries_with_evidence_then_fails(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:REVIEW_REJECT\n", max_retries=1,
                 files_hint="[output_001.txt]")

    counts = run_dispatcher(review_config(), backlog, tmp_path / "run")

    assert counts == {"FAILED": 1}
    events = list(EventLog.replay(tmp_path / "run" / "events.jsonl"))
    retries = [e for e in events if e["event"] == "retry"]
    assert len(retries) == 1
    assert "assertions were weakened" in retries[0]["reason"]
    # nothing rejected ever reaches main, and branches are cleaned up
    assert "output_001.txt" not in git(repo, "ls-tree", "--name-only", "main")
    assert git(repo, "branch", "--list", "agent/*") == ""


def test_review_diff_ignores_base_advance(tmp_path, repo):
    """A sibling merging into the base AFTER this branch forked must not appear in
    the review diff — otherwise it reads as scope creep this ticket never made
    (exactly what blocked the DiagnosticsModal extraction against a moved main)."""
    from factory.review import build_review_prompt
    from factory.task import parse_ticket

    # Fork a ticket branch and add only this ticket's own file.
    git(repo, "checkout", "-b", "agent/feat")
    (repo / "diagnostics.txt").write_text("mine\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "extract diagnostics")

    # The base advances with an unrelated sibling change while we were away.
    git(repo, "checkout", "main")
    (repo / "sibling.txt").write_text("theirs\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "sibling extraction")
    git(repo, "checkout", "agent/feat")

    backlog = tmp_path / "backlog"
    task = parse_ticket(write_ticket(backlog, "038", repo), "main")
    prompt = build_review_prompt(task, repo)

    assert "diagnostics.txt" in prompt          # the ticket's real work is shown
    assert "sibling.txt" not in prompt          # two-dot would wrongly surface it


def test_review_disabled_by_default(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:REVIEW_REJECT\n")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    # reviewer never ran: the reject marker is inert, the task merges
    assert counts == {"DONE": 1}
    events = [e["event"] for e in EventLog.replay(tmp_path / "run" / "events.jsonl")]
    assert "review" not in events
