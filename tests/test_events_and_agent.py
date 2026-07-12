from __future__ import annotations

import json

from factory.agent import extract_trailing_json, is_rate_limit_result
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


def test_rate_limit_detection_is_structured_only():
    # Regression (live, 2026-07-11): '429' inside a base64 thinking signature
    # flagged a SUCCESSFUL agent as rate-limited. Success records must never
    # trip the detector, whatever their payload contains.
    success = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "api_error_status": None,
        "result": "done — signature blob: aGVsbG8+429/dGhlcmU= rate limit mentioned in prose",
    }
    assert not is_rate_limit_result(success)
    assert is_rate_limit_result({"type": "result", "api_error_status": 429})
    assert is_rate_limit_result(
        {"type": "result", "is_error": True, "result": "API Error: rate limit exceeded"}
    )
    assert not is_rate_limit_result(
        {"type": "result", "is_error": True, "result": "some unrelated failure"}
    )


def test_stream_headless_handles_oversized_line(tmp_path):
    """A single stream-json record bigger than asyncio's default 64 KiB readline
    buffer (e.g. a task writing inline SVG charts) used to raise
    'Separator is found, but chunk is longer than limit' and kill the task.
    Regression for the Stats-section failure on 2026-07-12.
    """
    import asyncio
    import sys

    from factory.agent import stream_headless

    big_len = 300_000  # ~300 KB on one line, well past the old 64 KiB limit
    # The child builds the huge line itself: passing it as an argv would blow the
    # OS command-line length ceiling (WinError 206). Keep the argv tiny.
    child = (
        "import json,sys;"
        f"big='S'*{big_len};"
        "sys.stdout.write(json.dumps({'type':'result','num_turns':1,'result':big}))"
    )
    cmd = [sys.executable, "-c", child]

    out = asyncio.run(stream_headless(cmd, "prompt", tmp_path, tmp_path / "log.jsonl", 30.0))

    assert out.result is not None
    assert out.result["result"] == "S" * big_len
