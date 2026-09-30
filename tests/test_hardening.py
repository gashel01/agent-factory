"""Reliability and safety hardening: the guard hook, stream-json input, process-tree
kills, the run lock, crash recovery, rate-limit episodes, BLOCKED dependents,
verification strictness, best-of-N, and the sandbox's git hand-off."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest

from conftest import git, write_ticket
from factory import agent_hooks
from factory import worktree as wt_mod
from factory.agent import (
    StreamOutcome,
    _stdin_payload,
    outcome_rate_limited,
    stream_headless,
)
from factory.config import RateLimitConfig, VerifyConfig
from factory.dispatcher import Dispatcher
from factory.events import EventLog
from factory.recovery import recover, unfinished_runs
from factory.runlock import LockBusy, RunLock, holder, pid_alive
from factory.task import TaskState, load_backlog, parse_ticket
from factory.verify import run_verify
from test_e2e import make_config, run_dispatcher

# ------------------------------------------------------------------ guard hook


@pytest.mark.parametrize("command", [
    "git reset --hard HEAD~1",
    "git -C . reset --hard",
    'bash -c "git status; git rebase main"',
    "python -c \"import subprocess; subprocess.run(['git', 'reset', '--hard'])\"",
    "os.system('git push --force origin main')",
    "git push origin +main",
    "git clean -fdx",
    "git checkout -- src/app.py",
    "git restore src/app.py",
    "git branch -D agent/x",
    "git stash drop",
    "git worktree remove ../other",
    "git config core.hooksPath /tmp/h",
    "git update-ref refs/heads/main HEAD~3",
    "rm -rf .git",
    "echo evil > .git/hooks/pre-commit",
])
def test_guard_blocks_destructive_commands_however_wrapped(command):
    reason = agent_hooks.guard({"tool_name": "Bash", "tool_input": {"command": command}},
                               "agent")
    assert reason, command


@pytest.mark.parametrize("command", [
    "git status", "git add -A", "git commit -m 'fix: x'", "git diff main...HEAD",
    "git log --oneline", "git checkout -b feature", "git restore --staged a.py",
    "pytest -q", "cat .gitignore", "ls .github/workflows", "git merge --no-edit main",
])
def test_guard_lets_ordinary_work_through(command):
    assert agent_hooks.guard({"tool_name": "Bash", "tool_input": {"command": command}},
                             "agent") is None


def test_guard_blocks_file_writes_into_dotgit_and_supervisor_control_writes():
    write = {"tool_name": "Write", "tool_input": {"file_path": "/w/.git/config"}}
    assert agent_hooks.guard(write, "agent")
    ok = {"tool_name": "Edit", "tool_input": {"file_path": "/w/src/.gitignore"}}
    assert agent_hooks.guard(ok, "agent") is None
    ctl = {"tool_name": "Write", "tool_input": {"file_path": "runs/r1/control.jsonl"}}
    assert agent_hooks.guard(ctl, "supervisor")
    ticket = {"tool_name": "Write", "tool_input": {"file_path": "backlog/007.md"}}
    assert agent_hooks.guard(ticket, "supervisor") is None


def test_guard_script_exits_2_with_a_reason_on_stdin_payload():
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git rebase main"}})
    proc = subprocess.run(
        [sys.executable, str(Path(agent_hooks.__file__)), "guard", "--role", "agent"],
        input=payload, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 2
    assert "Blocked by Warden" in proc.stderr and "blocked" in proc.stderr


# ---------------------------------------------------------- stream-json + kills


def test_prompt_goes_over_stdin_as_a_stream_json_user_message():
    cmd = ["claude", "-p", "--input-format", "stream-json"]
    message = json.loads(_stdin_payload(cmd, "héllo").decode("utf-8"))
    assert message["type"] == "user"
    assert message["message"]["content"][0]["text"] == "héllo"
    assert _stdin_payload(["some-cli"], "raw") == b"raw"


def test_stderr_overload_warning_does_not_discard_a_successful_result():
    ok = {"type": "result", "is_error": False, "result": "done"}
    out = StreamOutcome(returncode=0, result=ok, stderr_rate_limited=True,
                        stderr_tail="overloaded, retrying", wall_s=1.0)
    assert not outcome_rate_limited(out)
    none = StreamOutcome(returncode=1, result=None, stderr_rate_limited=True,
                         stderr_tail="429", wall_s=1.0)
    assert outcome_rate_limited(none)


def test_timeout_kills_the_agents_whole_process_tree(tmp_path):
    # The "agent" starts a grandchild that would outlive a plain proc.kill().
    marker = tmp_path / "child.pid"
    script = tmp_path / "agent.py"
    script.write_text(
        "import subprocess, sys, time, pathlib\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"pathlib.Path(r'{marker}').write_text(str(child.pid))\n"
        "time.sleep(120)\n",
        encoding="utf-8",
    )
    with pytest.raises(TimeoutError):
        asyncio.run(stream_headless([sys.executable, str(script)], "", tmp_path,
                                    tmp_path / "log.jsonl", timeout_s=3.0))
    child = int(marker.read_text())
    deadline = time.monotonic() + 10
    while pid_alive(child) and time.monotonic() < deadline:
        time.sleep(0.2)
    assert not pid_alive(child), "the agent's child process survived the kill"


# ------------------------------------------------------------------- run lock


def test_run_lock_is_exclusive_and_recovers_from_a_stale_owner(tmp_path):
    path = tmp_path / "runs" / ".factory.lock"
    with RunLock([path], run="a"):
        assert holder(path)["run"] == "a"
        with pytest.raises(LockBusy, match="already in progress"):
            RunLock([path], run="b").acquire()
    assert not path.exists()

    # A lock left by a dead process is taken over, not obeyed forever.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pid": 999_999_999, "run": "dead"}), encoding="utf-8")
    assert holder(path) is None
    with RunLock([path], run="c"):
        assert holder(path)["run"] == "c"


def test_pid_alive_probes_without_harming_the_process():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert pid_alive(proc.pid)
        assert pid_alive(proc.pid), "probing must not kill it (Windows os.kill does)"
        assert proc.poll() is None
    finally:
        proc.kill()
        proc.wait()
    assert not pid_alive(proc.pid)


# ------------------------------------------------------------------ recovery


def _crashed_run(runs: Path, repo: Path, task_id: str, *, with_commit: bool) -> Path:
    """What a kill -9 leaves behind: a started log, a worktree, a task branch."""
    run_dir = runs / "2026-01-01_000000"
    log = EventLog(run_dir / "events.jsonl")
    log.emit("run_start", run=run_dir.name, tasks=[{"id": task_id}])
    log.emit("state", task=task_id, **{"from": "QUEUED", "to": "RUNNING"})
    wt = wt_mod.create(repo, run_dir / "wt", run_dir.name, task_id, "main")
    if with_commit:
        (wt.path / "partial.txt").write_text("half done\n", encoding="utf-8")
        git(wt.path, "add", "partial.txt")
        git(wt.path, "commit", "-m", "feat: half of the ticket")
    return run_dir


def test_recovery_closes_the_dead_run_and_keeps_work_in_progress(tmp_path, repo):
    runs = tmp_path / "runs"
    run_dir = _crashed_run(runs, repo, "001", with_commit=True)
    assert unfinished_runs(runs) == [run_dir]

    report = recover(runs, {repo: "main"})

    assert unfinished_runs(runs) == []
    ends = [e for e in EventLog.replay(run_dir / "events.jsonl") if e["event"] == "run_end"]
    assert ends and ends[-1]["crashed"] is True
    assert not (run_dir / "wt" / "001").exists()
    branch = report.adopt[(repo.resolve(), "001")]
    assert "half of the ticket" in git(repo, "log", "--oneline", branch)


def test_recovery_deletes_empty_branches(tmp_path, repo):
    runs = tmp_path / "runs"
    _crashed_run(runs, repo, "001", with_commit=False)
    report = recover(runs, {repo: "main"})
    assert report.adopt == {} and report.deleted_branches == 1
    assert git(repo, "branch", "--list", "agent/*") == ""


def test_next_run_continues_an_adopted_branch(tmp_path, repo):
    runs = tmp_path / "runs"
    _crashed_run(runs, repo, "001", with_commit=True)
    report = recover(runs, {repo: "main"})
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt, partial.txt]")
    tasks = load_backlog(backlog, "main")
    tasks[0].adopt_branch = report.adopt[(repo.resolve(), "001")]
    run_dir = runs / "2026-01-02_000000"
    run_dir.mkdir()

    counts = asyncio.run(Dispatcher(make_config(), tasks, run_dir).run())

    assert counts == {"DONE": 1}
    # Both the interrupted work and the new work landed.
    assert (repo / "partial.txt").exists() and (repo / "output_001.txt").exists()
    events = [e["event"] for e in EventLog.replay(run_dir / "events.jsonl")]
    assert "adopted" in events


# ----------------------------------------------------------------- rate limit


def _dispatcher(tmp_path, repo, **cfg) -> Dispatcher:
    tmp_path.mkdir(parents=True, exist_ok=True)
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo)
    run_dir = tmp_path / "run"
    run_dir.mkdir(parents=True)
    return Dispatcher(make_config(**cfg), load_backlog(backlog, "main"), run_dir)


def test_one_rate_limit_episode_counts_once_across_slots(tmp_path, repo):
    d = _dispatcher(tmp_path, repo,
                    ratelimit=RateLimitConfig(cooldown_min=1, max_pauses_before_stop=1))
    for _ in range(4):  # four slots hitting the same limit at once
        d._trigger_pause()
    assert d._pause_count == 1 and not d._stopped


def test_pause_waits_for_the_announced_reset_or_stops_if_too_far(tmp_path, repo):
    d = _dispatcher(tmp_path, repo, ratelimit=RateLimitConfig(cooldown_min=1, max_wait_min=60))
    d._trigger_pause(resets_at=time.time() + 600)
    assert 600 <= d._pause_until - time.monotonic() <= 700
    assert not d._stopped

    far = _dispatcher(tmp_path / "far", repo,
                      ratelimit=RateLimitConfig(cooldown_min=1, max_wait_min=60))
    far._trigger_pause(resets_at=time.time() + 3 * 24 * 3600)  # a weekly cap
    assert far._stopped


def test_a_successful_agent_clears_the_rate_limit_streak(tmp_path, repo):
    d = _dispatcher(tmp_path, repo, ratelimit=RateLimitConfig(cooldown_min=0))
    d._trigger_pause()
    d._pause_until = 0.0
    d._trigger_pause()
    assert d._pause_count == 2
    d._rate_limit_cleared()
    assert d._pause_count == 0


# -------------------------------------------------------- blocked dependencies


def test_dependents_of_a_blocked_ticket_wait_for_the_answer(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:BLOCKED\n", files_hint="[output_001.txt]")
    write_ticket(backlog, "002", repo, depends_on='["001"]', files_hint="[output_002.txt]")
    tasks = load_backlog(backlog, "main")
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    async def scenario():
        d = Dispatcher(make_config(), tasks, run_dir)
        runner = asyncio.create_task(d.run())
        for _ in range(600):
            if d.state["001"] is TaskState.BLOCKED:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)
        # The dependent is still queued — waiting, not failed.
        assert d.state["002"] is TaskState.QUEUED
        (run_dir / "control.jsonl").write_text(
            json.dumps({"op": "answer", "task": "001", "text": "use sqlite"}) + "\n",
            encoding="utf-8",
        )
        return await runner

    counts = asyncio.run(scenario())
    assert counts == {"DONE": 2}
    events = [e["event"] for e in EventLog.replay(run_dir / "events.jsonl")]
    assert "waiting_on_operator" in events


def test_blocked_wait_is_bounded(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, body="STUB:BLOCKED\n", files_hint="[a]")
    write_ticket(backlog, "002", repo, depends_on='["001"]', files_hint="[b]")
    counts = run_dispatcher(make_config(blocked_wait_min=0), backlog, tmp_path / "run")
    assert counts == {"BLOCKED": 1, "FAILED": 1}
    failures = [e for e in EventLog.replay(tmp_path / "run" / "events.jsonl")
                if e["event"] == "failure"]
    assert "left in the backlog" in failures[0]["reason"]


# -------------------------------------------------------------- verification


def _branch_with(tmp_path, repo, files: dict[str, str | None], **meta):
    tmp_path.mkdir(parents=True, exist_ok=True)
    task = parse_ticket(write_ticket(tmp_path / "backlog", "001", repo, **meta), "main")
    wt = wt_mod.create(repo, tmp_path / "wt", f"run-{tmp_path.name}", task.id, "main")
    for name, content in files.items():
        path = wt.path / name
        if content is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    git(wt.path, "add", "-A")
    git(wt.path, "commit", "-m", "change")
    return task, wt


def test_verify_requires_a_success_criteria_command_by_default(tmp_path, repo):
    task, wt = _branch_with(tmp_path, repo, {"a.py": "x = 1\n"})
    result = run_verify(task, wt.path, VerifyConfig())
    assert not result.ok and "no success-criteria command" in result.failures[0]
    assert run_verify(task, wt.path, VerifyConfig(commands=('python -c "exit(0)"',))).ok


def test_verify_rejects_changes_to_the_judging_machinery(tmp_path, repo):
    (repo / "tests").mkdir()
    (repo / "tests" / "test_core.py").write_text("def test_x():\n    assert True\n",
                                                 encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "tests")
    ok_cmd = VerifyConfig(commands=('python -c "exit(0)"',))

    task, wt = _branch_with(tmp_path, repo, {"conftest.py": "collect_ignore = ['tests']\n"})
    result = run_verify(task, wt.path, ok_cmd)
    assert not result.ok and "conftest.py" in result.failures[0]

    task2, wt2 = _branch_with(tmp_path / "b", repo, {"tests/test_core.py": None})
    result2 = run_verify(task2, wt2.path, ok_cmd)
    assert not result2.ok and "deleted test file" in result2.failures[0]

    # A ticket that OWNS the file (files_hint) may change it.
    task3, wt3 = _branch_with(tmp_path / "c", repo, {"conftest.py": "import os\n"},
                              files_hint="[conftest.py]")
    assert run_verify(task3, wt3.path, ok_cmd).ok


# ------------------------------------------------------------------- best-of-N


def test_best_of_n_runs_candidates_and_merges_one_winner(tmp_path, repo):
    backlog = tmp_path / "backlog"
    write_ticket(backlog, "001", repo, files_hint="[output_001.txt]")
    run_dir = tmp_path / "run"

    counts = run_dispatcher(make_config(max_slots=3, candidates=2), backlog, run_dir)

    assert counts == {"DONE": 1}
    events = list(EventLog.replay(run_dir / "events.jsonl"))
    cand = [e for e in events if e["event"] == "candidates"]
    assert cand and len(cand[0]["outcomes"]) == 2 and cand[0]["winner"] in (1, 2)
    assert len([e for e in events if e["event"] == "agent_result"]) == 2
    # The loser's worktree and branch are gone.
    assert git(repo, "branch", "--list", "agent/*") == ""
    assert (repo / "output_001.txt").exists()


# ------------------------------------------------------------- sandbox git


def test_sanitize_restores_a_replaced_gitlink(tmp_path, repo):
    wt = wt_mod.create(repo, tmp_path / "wt", "run1", "001", "main")
    original = (wt.path / ".git").read_text(encoding="utf-8")
    (wt.path / ".git").unlink()
    (wt.path / ".git").mkdir()
    (wt.path / ".git" / "config").write_text("[core]\n\tfsmonitor = evil\n", encoding="utf-8")
    wt_mod.sanitize_gitlink(wt)
    assert (wt.path / ".git").is_file()
    assert (wt.path / ".git").read_text(encoding="utf-8") == original


def test_box_commits_come_home_through_a_bundle(tmp_path, repo):
    """Simulate what the box does (commit in a separate repo sharing the history,
    export a bundle + head.txt) and check the host imports it as the task branch,
    leaving the agent's working-tree files as they were."""
    from factory import sandbox

    wt = wt_mod.create(repo, tmp_path / "wt", "run1", "001", "main")
    start = git(wt.path, "rev-parse", "HEAD")
    box = sandbox.Box(name="t", worktree=wt.path, start=start, branch=wt.branch,
                      out_dir=tmp_path / "out")
    box.out_dir.mkdir()

    scratch = tmp_path / "scratch"
    subprocess.run(["git", "clone", "-q", str(repo), str(scratch)], check=True)
    git(scratch, "config", "user.email", "a@b.c")
    git(scratch, "config", "user.name", "agent")
    (scratch / "feature.txt").write_text("from the box\n", encoding="utf-8")
    git(scratch, "add", "feature.txt")
    git(scratch, "commit", "-m", "feat: made in the box")
    head = git(scratch, "rev-parse", "HEAD")
    git(scratch, "update-ref", "refs/warden/export", head)
    git(scratch, "bundle", "create", str(box.out_dir / "result.bundle"),
        "refs/warden/export", f"^{start}")
    (box.out_dir / "head.txt").write_text(head + "\n", encoding="utf-8")
    # The agent's files as it left them in the mounted worktree.
    (wt.path / "feature.txt").write_text("from the box\n", encoding="utf-8")

    sandbox.import_result(wt, box)

    assert git(repo, "rev-parse", wt.branch) == head
    assert git(wt.path, "status", "--porcelain") == ""
    assert git(repo, "for-each-ref", "refs/warden/") == ""  # no stray import refs


def test_wrap_never_mounts_the_host_git_dir(tmp_path, repo):
    from factory import sandbox

    wt = wt_mod.create(repo, tmp_path / "wt", "run1", "001", "main")
    box = sandbox.box_for(wt, tag="agent", out_dir=tmp_path / "out")
    cmd = sandbox.wrap(["claude", "-p"], wt.path, box)
    mounts = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-v"]
    assert not any(m.endswith(":/repo/.git") or "/.git:" in m.split(":/")[0] + ":"
                   for m in mounts if ":/base/objects" not in m)
    objects = [m for m in mounts if ":/base/objects" in m]
    assert objects and objects[0].endswith(":ro")
    assert "--tmpfs" in cmd and "--name" in cmd
    assert cmd[cmd.index("--name") + 1] == box.name


def test_verify_config_is_strict_by_default():
    assert VerifyConfig().require_commands is True
    assert replace(VerifyConfig(), require_commands=False).require_commands is False
