from __future__ import annotations

import asyncio
import json
import sys

from factory.agent import (
    describe_step,
    extract_trailing_json,
    is_rate_limit_result,
    stream_headless,
)
from factory.events import EventLog


def _assistant(*blocks):
    return {"type": "assistant", "message": {"content": list(blocks)}}


def test_describe_step_prefers_tool_use():
    read = _assistant(
        {"type": "tool_use", "name": "Read", "input": {"file_path": "C:/repo/src/auth.py"}}
    )
    assert describe_step(read) == "reading auth.py"
    grep = _assistant({"type": "tool_use", "name": "Grep", "input": {"pattern": "login"}})
    assert describe_step(grep) == 'searching for "login"'
    glob = _assistant({"type": "tool_use", "name": "Glob", "input": {"pattern": "**/*.ts"}})
    assert describe_step(glob) == "finding files matching **/*.ts"


def test_describe_step_falls_back_to_narration_and_none():
    # A leading blank text block is skipped in favour of the tool call.
    mixed = _assistant(
        {"type": "text", "text": "  "},
        {"type": "tool_use", "name": "Read", "input": {"file_path": "x/y/config.yaml"}},
    )
    assert describe_step(mixed) == "reading config.yaml"
    # No tool this turn: first line of narration, trimmed.
    narr = _assistant({"type": "text", "text": "Now I understand the flow.\nNext: tests."})
    assert describe_step(narr) == "Now I understand the flow."
    # Nothing worth showing.
    assert describe_step(_assistant()) is None


def test_stream_headless_reports_live_activity(tmp_path):
    """The on_activity callback fires for each assistant record as it streams,
    so the planner can surface a live feed instead of a silent wait."""
    fake = tmp_path / "fake_agent.py"
    fake.write_text(
        "import sys, json\n"
        "sys.stdin.read()\n"
        "for rec in [\n"
        "  {'type':'assistant','message':{'content':[{'type':'tool_use',"
        "'name':'Read','input':{'file_path':'a/b/main.py'}}]}},\n"
        "  {'type':'assistant','message':{'content':[{'type':'tool_use',"
        "'name':'Grep','input':{'pattern':'token'}}]}},\n"
        "  {'type':'result','result':'{\\\"status\\\":\\\"done\\\"}'},\n"
        "]:\n"
        "  print(json.dumps(rec), flush=True)\n",
        encoding="utf-8",
    )
    steps: list[str] = []
    outcome = asyncio.run(stream_headless(
        [sys.executable, str(fake)], "prompt", tmp_path, tmp_path / "log.jsonl",
        timeout_s=30,
        on_activity=lambda rec: (lambda s: steps.append(s) if s else None)(describe_step(rec)),
    ))
    assert outcome.returncode == 0
    assert steps == ["reading main.py", 'searching for "token"']


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


# -- the npm envelope ------------------------------------------------------
#
# On Windows `shutil.which("claude")` returns npm's `claude.CMD`, so the child
# we hold is a `cmd.exe` wrapping the real CLI. `stream_headless` kills that
# child on timeout and on cancellation -- normal paths here, not edge cases --
# and killing the wrapper leaves `claude.exe` running: past the deadline, still
# calling tools, still spending against the one OAuth bucket every slot shares.
# It raises nothing. These tests exist because the failure is invisible.

def _shim(folder, line: str, name: str = "claude.cmd"):
    path = folder / name
    path.write_text(f"@ECHO off\r\n{line}\r\n", encoding="utf-8")
    return path


def _resolved(monkeypatch, path) -> str:
    """`_without_the_shim` on a path, as if we were on Windows.

    The cache is cleared each time: it exists so the warning is said once in
    production, and two tests sharing it would observe each other.
    """
    from factory import agent

    monkeypatch.setattr(agent.os, "name", "nt")
    agent._without_the_shim.cache_clear()
    return agent._without_the_shim(str(path))


def test_the_npm_shim_is_read_rather_than_launched(tmp_path, monkeypatch):
    """The shim names its own executable on one line. Reading it beats guessing
    an npm layout, which moves with the package manager."""
    import os

    exe = tmp_path / "claude.exe"
    exe.write_bytes(b"MZ")
    shim = _shim(tmp_path, f'"{exe}" %*')

    assert _resolved(monkeypatch, shim) == os.path.normpath(str(exe))


def test_the_shim_is_read_through_its_own_directory_variable(tmp_path, monkeypatch):
    """npm writes the path relative to the shim with `%~dp0`, so a literal read
    finds a file that does not exist and falls back to the envelope."""
    import os

    exe = tmp_path / "node.exe"
    exe.write_bytes(b"MZ")
    shim = _shim(tmp_path, r'"%~dp0\node.exe" "%~dp0\cli.js" %*')

    assert _resolved(monkeypatch, shim) == os.path.normpath(str(exe))


def test_an_unresolvable_shim_falls_back_and_says_so(tmp_path, monkeypatch, caplog):
    """Falling back is the safe direction -- it works, it costs a cmd.exe -- but
    silent it reads as "nothing to report", when what it means is that a timeout
    has stopped stopping the agent."""
    import logging

    shim = _shim(tmp_path, r'"%~dp0\node.exe" "%~dp0\cli.js" %*')  # no node.exe

    with caplog.at_level(logging.WARNING, logger="factory.agent"):
        assert _resolved(monkeypatch, shim) == str(shim)

    assert any("cmd.exe" in r.getMessage() for r in caplog.records), \
        "the envelope came back and nothing said so"


def test_a_real_executable_is_left_alone(tmp_path, monkeypatch):
    """Only `.cmd` and `.bat` are envelopes. Anything else is already the thing
    itself, and reading it as text would be nonsense."""
    exe = tmp_path / "claude.exe"
    exe.write_bytes(b"MZ")

    assert _resolved(monkeypatch, exe) == str(exe)


def test_build_cli_resolves_the_shim(tmp_path, monkeypatch):
    """The whole point: what `build_cli` hands to `create_subprocess_exec` must
    be the CLI, not the wrapper."""
    import os

    from factory import agent

    exe = tmp_path / "claude.exe"
    exe.write_bytes(b"MZ")
    shim = _shim(tmp_path, f'"{exe}" %*')

    monkeypatch.setattr(agent.shutil, "which", lambda _: str(shim))
    monkeypatch.setattr(agent.os, "name", "nt")
    agent._without_the_shim.cache_clear()

    cmd = agent.build_cli(("claude",), max_turns=3, allowed_tools=())
    assert cmd[0] == os.path.normpath(str(exe)), "build_cli handed back the wrapper"
