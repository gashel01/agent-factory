"""Stand-in for the `claude` CLI so the whole pipeline is testable without tokens.

Reads the prompt from stdin like the real CLI, makes a commit in the current
worktree, and prints a stream-json `result` record. Behaviour switches on markers
embedded in the ticket body:

  STUB:NO_COMMIT   -> exit "done" without committing (verify gate must catch it)
  STUB:BLOCKED     -> report status=blocked with a question
  STUB:RATELIMIT   -> print a rate-limit error line and exit non-zero
  STUB:SLEEP       -> hang for 60s (kill/timeout paths)
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time


def main() -> int:
    prompt = sys.stdin.read()
    match = re.search(r"Ticket ID:\s*(\S+)", prompt)
    task_id = match.group(1) if match else "unknown"

    if "previous attempt on this ticket did not pass" in prompt:
        # A resumed retry: short corrective prompt, no contract. Prove the resume
        # actually happened (--resume on argv, same worktree) by committing a fix
        # that records the resumed session id.
        if "--resume" in sys.argv:
            session = sys.argv[sys.argv.index("--resume") + 1]
            with open("fixed_by_resume.txt", "w", encoding="utf-8") as fh:
                fh.write(f"resumed session {session}\n")
            subprocess.run(["git", "add", "-A"], check=True)
            subprocess.run(["git", "commit", "-m", "fix: finish after resume"], check=True)
        contract = {"status": "done", "summary": "fixed after resume", "tests": "pass"}
        print(json.dumps({"type": "result", "num_turns": 1,
                          "session_id": "stub-agent-session-2",
                          "result": f"Done.\n{json.dumps(contract)}"}))
        return 0

    if "STUB:SLEEP" in prompt:
        time.sleep(60)
        return 0

    if "Capability check" in prompt:
        verdict = {"status": "done", "internet": "denied",
                   "commands": [{"cmd": "git --version", "result": "ok"}],
                   "notes": ""}
        print(json.dumps({"type": "result", "num_turns": 3,
                          "result": json.dumps(verdict)}))
        return 0

    if "Supervisor contract" in prompt:
        answer = {"status": "done", "reply": "1 task is running, none failed.", "actions": []}
        print(json.dumps({"type": "result", "num_turns": 2,
                          "session_id": "stub-supervisor-session",
                          "result": json.dumps(answer)}))
        return 0

    if "Review contract" in prompt:
        if "STUB:REVIEW_RATELIMIT" in prompt:
            print("API Error: 429 rate limit exceeded", file=sys.stderr)
            return 1
        if "STUB:REVIEW_REJECT" in prompt:
            verdict = {"status": "done", "verdict": "reject",
                       "reasons": ["assertions were weakened to pass"]}
        else:
            verdict = {"status": "done", "verdict": "approve", "reasons": []}
        print(json.dumps({"type": "result", "num_turns": 2, "result": json.dumps(verdict)}))
        return 0

    if "Clarify-first contract" in prompt:
        questions = [
            {"q": "Which text operations do you need?", "why": "scopes the tickets",
             "suggestions": ["slugify + truncate", "just slugify", "a full text module"]},
            {"q": "Should it be pure-Python (no deps)?", "why": "changes the harness",
             "suggestions": ["yes, stdlib only", "third-party ok"]},
        ]
        payload = {"status": "questions", "questions": questions}
        print(json.dumps({"type": "result", "num_turns": 3, "result": json.dumps(payload)}))
        return 0

    if "Autopilot supervisor" in prompt:
        # Decompose once, then declare done: "continue" while nothing has landed on
        # the work branch, "done" once progress shows a commit.
        if "(nothing yet)" in prompt:
            payload = {"status": "continue", "objective": "STUB:LOOP do the next chunk"}
        else:
            payload = {"status": "done", "reason": "mission complete"}
        print(json.dumps({"type": "result", "num_turns": 2, "result": json.dumps(payload)}))
        return 0

    if "Planning contract" in prompt:
        if "STUB:LOOP" in prompt:
            # Loop-friendly plan: two disjoint tickets with NO verify command, so
            # each just commits and passes the git-only verify gate (the default
            # unittest tickets below would fail — there is no tests/ dir).
            loop_tickets = [
                {"id": "001", "title": "loop step A", "files_hint": ["output_a.txt"],
                 "depends_on": [], "priority": 1, "timeout_min": 15, "verify": [],
                 "body": "## Context\nloop.\n## Success criteria\ncommit.\n## Out of scope\nx."},
                {"id": "002", "title": "loop step B", "files_hint": ["output_b.txt"],
                 "depends_on": [], "priority": 1, "timeout_min": 15, "verify": [],
                 "body": "## Context\nloop.\n## Success criteria\ncommit.\n## Out of scope\nx."},
            ]
            print(json.dumps({"type": "result", "num_turns": 3,
                              "result": json.dumps({"status": "done", "brief": "loop map.",
                                                    "tickets": loop_tickets})}))
            return 0
        tickets = [
            {
                "id": "001", "title": "Set up the test harness",
                "files_hint": ["tests/"], "depends_on": [], "priority": 1,
                "timeout_min": 15, "verify": ["python -m unittest discover -s tests"],
                "body": "## Context\nNo tests yet.\n## Success criteria\nharness runs.\n"
                        "## Out of scope\nfeatures.",
            },
            {
                "id": "002", "title": "Add slugify helper",
                "files_hint": ["src/text.py"], "depends_on": ["001"], "priority": 2,
                "timeout_min": 30, "verify": ["python -m unittest discover -s tests"],
                "body": "## Context\n...\n## Success criteria\ntests pass.\n"
                        "## Out of scope\nother modules.",
            },
        ]
        # Reflect whether an existing project map was injected, so tests can
        # prove the brief reaches the planner instead of a full re-scan.
        brief = "Stub project map." + (" [reused]" if "# Project map" in prompt else "")
        payload = {"status": "done", "brief": brief, "tickets": tickets}
        print(json.dumps({"type": "result", "num_turns": 5, "result": json.dumps(payload)}))
        return 0

    if "STUB:RATELIMIT" in prompt:
        print("API Error: 429 rate limit exceeded", file=sys.stderr)
        return 1

    if "STUB:BLOCKED" in prompt:
        contract = {"status": "blocked", "summary": "which database should I use?", "tests": "fail"}
        print(json.dumps({"type": "result", "num_turns": 1, "result": json.dumps(contract)}))
        return 0

    if "STUB:DECISION" in prompt and "The operator chose:" not in prompt:
        # First pass: offer the operator a genuine design choice with previews.
        contract = {
            "status": "decision", "summary": "which header layout?", "tests": "fail",
            "options": [
                {"id": "a", "label": "Sidebar left", "detail": "nav in a left rail",
                 "preview_html": "<div style='padding:8px'>left</div>"},
                {"id": "b", "label": "Top bar", "detail": "nav across the top"},
            ],
        }
        print(json.dumps({"type": "result", "num_turns": 1, "result": json.dumps(contract)}))
        return 0

    if "STUB:NOOP" in prompt:
        # The change already exists: report an explicit no-op (done + noop) WITHOUT
        # committing. The dispatcher must accept this as DONE, not fail on "no commits".
        contract = {"status": "done", "noop": True,
                    "summary": "already implemented", "tests": "pass"}
        print(json.dumps({"type": "result", "num_turns": 1, "result": json.dumps(contract)}))
        return 0

    if "STUB:MAXTURNS" in prompt:
        # Mimic the real CLI hitting --max-turns: a result record carrying the
        # max-turns subtype AND a non-zero exit, with a session id to resume. The
        # resume branch at the top then finishes the ticket, proving the dispatcher
        # CONTINUES (resumes) instead of failing and burning a retry.
        print(json.dumps({"type": "result", "subtype": "error_max_turns",
                          "num_turns": 65, "session_id": "stub-maxturns-session",
                          "result": "ran out of turns before finishing"}))
        return 1

    if "Ticket ID:" not in prompt:
        # Short prompt without any contract: a resumed supervisor exchange.
        answer = {"status": "done", "reply": f"resumed: {prompt.strip()[:60]}", "actions": []}
        print(json.dumps({"type": "result", "num_turns": 1,
                          "session_id": "stub-supervisor-session",
                          "result": json.dumps(answer)}))
        return 0

    if "STUB:NO_COMMIT" not in prompt and "STUB:RESUME_FIX" not in prompt:
        filename = f"output_{task_id}.txt"
        with open(filename, "w", encoding="utf-8") as fh:
            fh.write(f"work for {task_id}\n")
        subprocess.run(["git", "add", filename], check=True)
        subprocess.run(["git", "commit", "-m", f"feat({task_id}): add output"], check=True)

    # A plan-window snapshot like the real CLI streams (5h reset + status), so the
    # subscription plan-usage indicator has something to show. Reset is ~2h out so a
    # live countdown looks real.
    print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {
        "status": "allowed", "resetsAt": int(time.time()) + 7200,
        "rateLimitType": "five_hour"}}))

    # Emit a couple of streaming assistant turns so live-progress (C6) has something
    # to report; the real CLI streams these before the final result record.
    for i in (1, 2):
        print(json.dumps({"type": "assistant",
                          "message": {"usage": {"input_tokens": 40 * i, "output_tokens": 10 * i}}}))
        sys.stdout.flush()

    contract = {"status": "done", "summary": f"completed {task_id}", "tests": "pass"}
    final = f"All done.\n{json.dumps(contract)}"
    record = {
        "type": "result", "num_turns": 3, "result": final,
        "total_cost_usd": 1.0,
        "usage": {"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 50},
    }
    # A session id enables resumed retries; NO_COMMIT keeps none so its retry
    # path stays the historical cold restart (and keeps failing, as that test
    # expects).
    if "STUB:NO_COMMIT" not in prompt:
        record["session_id"] = f"stub-agent-session-{task_id}"
    print(json.dumps(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
