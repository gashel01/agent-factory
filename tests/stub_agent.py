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
        if "STUB:REVIEW_REJECT" in prompt:
            verdict = {"status": "done", "verdict": "reject",
                       "reasons": ["assertions were weakened to pass"]}
        else:
            verdict = {"status": "done", "verdict": "approve", "reasons": []}
        print(json.dumps({"type": "result", "num_turns": 2, "result": json.dumps(verdict)}))
        return 0

    if "Planning contract" in prompt:
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
        payload = {"status": "done", "tickets": tickets}
        print(json.dumps({"type": "result", "num_turns": 5, "result": json.dumps(payload)}))
        return 0

    if "STUB:RATELIMIT" in prompt:
        print("API Error: 429 rate limit exceeded", file=sys.stderr)
        return 1

    if "STUB:BLOCKED" in prompt:
        contract = {"status": "blocked", "summary": "which database should I use?", "tests": "fail"}
        print(json.dumps({"type": "result", "num_turns": 1, "result": json.dumps(contract)}))
        return 0

    if "Ticket ID:" not in prompt:
        # Short prompt without any contract: a resumed supervisor exchange.
        answer = {"status": "done", "reply": f"resumed: {prompt.strip()[:60]}", "actions": []}
        print(json.dumps({"type": "result", "num_turns": 1,
                          "session_id": "stub-supervisor-session",
                          "result": json.dumps(answer)}))
        return 0

    if "STUB:NO_COMMIT" not in prompt:
        filename = f"output_{task_id}.txt"
        with open(filename, "w", encoding="utf-8") as fh:
            fh.write(f"work for {task_id}\n")
        subprocess.run(["git", "add", filename], check=True)
        subprocess.run(["git", "commit", "-m", f"feat({task_id}): add output"], check=True)

    contract = {"status": "done", "summary": f"completed {task_id}", "tests": "pass"}
    final = f"All done.\n{json.dumps(contract)}"
    print(json.dumps({
        "type": "result", "num_turns": 3, "result": final,
        "total_cost_usd": 1.0,
        "usage": {"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 50},
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
