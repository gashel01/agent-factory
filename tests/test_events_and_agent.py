from __future__ import annotations

import json

from factory.agent import extract_trailing_json
from factory.events import EventLog


def test_event_log_roundtrip(tmp_path):
    log = EventLog(tmp_path / "events.jsonl")
    log.emit("run_start", run="r1", slots=3)
    log.emit("state", task="001", **{"from": "QUEUED", "to": "RUNNING"})
    events = list(EventLog.replay(tmp_path / "events.jsonl"))
    assert [e["event"] for e in events] == ["run_start", "state"]
    assert events[1]["task"] == "001"
    assert all("ts" in e for e in events)


def test_event_log_tolerates_torn_final_line(tmp_path):
    path = tmp_path / "events.jsonl"
    log = EventLog(path)
    log.emit("run_start", run="r1")
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"ts": "2026-01-01T00:00:00+00:00", "event": "sta')  # crash mid-write
    events = list(EventLog.replay(path))
    assert len(events) == 1


def test_extract_trailing_json_variants():
    contract = {"status": "done", "summary": "ok", "tests": "pass"}
    text = "I finished the work.\n" + json.dumps(contract)
    assert extract_trailing_json(text) == contract
    # tolerate a trailing code fence and whitespace
    assert extract_trailing_json(text + "\n``` \n") == contract
    # nested braces inside the summary
    nested = {"status": "done", "summary": "fixed {weird} case"}
    assert extract_trailing_json("done\n" + json.dumps(nested)) == nested
    assert extract_trailing_json("no json here") is None
    # a JSON block without "status" is not a contract
    assert extract_trailing_json('{"foo": 1}') is None
