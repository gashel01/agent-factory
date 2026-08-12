"""The visual decision gate: an agent that hits a genuine design fork offers
concrete options instead of guessing, the operator picks, the choice is recorded."""

from __future__ import annotations

from conftest import write_ticket
from factory.agent import parse_options
from factory.events import EventLog
from test_e2e import make_config, run_dispatcher


def test_parse_options_keeps_known_fields_and_caps():
    raw = [
        {"id": "a", "label": "Left", "detail": "nav left", "preview_html": "<b>x</b>"},
        {"label": "Right"},                     # id auto-filled, no preview
        {"detail": "no label"},                 # dropped: a label is required
        "not a dict",                           # dropped
    ]
    got = parse_options(raw)
    assert [o["label"] for o in got] == ["Left", "Right"]
    assert got[0]["preview_html"] == "<b>x</b>"
    assert got[1]["id"] == "opt-2"             # auto-numbered
    assert "preview_html" not in got[1]


def test_parse_options_bounds_count_and_sizes():
    raw = [{"label": f"opt {i}"} for i in range(20)]
    assert len(parse_options(raw)) == 6         # capped at _MAX_OPTIONS
    big = [{"label": "x" * 500, "detail": "y" * 5000, "preview_html": "z" * 500_000}]
    o = parse_options(big)[0]
    assert len(o["label"]) == 120 and len(o["detail"]) == 2000
    assert len(o["preview_html"]) == 200_000


def test_parse_options_rejects_non_list():
    assert parse_options(None) == ()
    assert parse_options({"label": "x"}) == ()
    assert parse_options("nope") == ()


def test_decision_parks_task_with_options_for_the_operator(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:DECISION\n")

    counts = run_dispatcher(make_config(), backlog, tmp_path / "run")

    # Parked like a block — it needs a human — but the event carries the choice.
    assert counts == {"BLOCKED": 1}
    blocked = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
               if e["event"] == "blocked"]
    assert blocked and blocked[0]["kind"] == "decision"
    assert "header layout" in blocked[0]["question"]
    labels = [o["label"] for o in blocked[0]["options"]]
    assert labels == ["Sidebar left", "Top bar"]
    # The visual option keeps its self-contained preview; the plain one has none.
    assert blocked[0]["options"][0]["preview_html"] == "<div style='padding:8px'>left</div>"
    assert "preview_html" not in blocked[0]["options"][1]
