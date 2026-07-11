# agent-factory

Run a fleet of parallel [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents
over a task backlog — with git-worktree isolation, deterministic verification gates, and a
sequential merge queue. **Works on a Claude subscription (no API key)**, on Windows, macOS,
and Linux.

```
backlog/*.md ──▶ DISPATCHER ──▶ N isolated worktrees, one headless agent each
                     │                      │
                     │                VERIFY GATE  (commits exist + tests pass)
                     │                      │
                     └──── retries ◀── MERGE QUEUE (rebase → re-verify → merge, one at a time)
                                            │
                                     events.jsonl  (append-only source of truth)
```

## Why

Running one coding agent is easy. Running twenty is an orchestration problem:

- **Isolation** — agents must not step on each other → one git worktree + branch per task.
- **Trust** — nobody reviews twenty diffs by hand → work only "exists" once a deterministic
  gate proves it (real commits + success-criteria commands exit 0), re-proven **after** rebase.
- **Budgets** — every task carries a wall-clock timeout and a max-turns cap; a run never
  bleeds cost silently.
- **Rate limits** — on a subscription plan, limits are a fact of life. The dispatcher pauses
  globally with exponential backoff, requeues the interrupted task *without* penalty, and
  stops cleanly (backlog intact) if the quota is truly exhausted.

## Quickstart

```bash
# 1. install (Python >= 3.11, git and the claude CLI on PATH)
pip install -e .

# 2. describe work as tickets
mkdir backlog && $EDITOR backlog/001-fix-auth.md   # see "Ticket format" below

# 3. sanity-check the schedule (parses everything, launches nothing)
factory run --dry-run

# 4. go — 3 parallel agents by default, your call entirely
factory run --slots 3
factory status
factory report
```

## Ticket format

One markdown file = one unit of agent work. YAML front matter + free-form body:

```markdown
---
id: "001"                   # quote ids — bare 001 is YAML for the integer 1
title: Fix token refresh in auth middleware
repo: ../myproject          # absolute, or relative to the ticket file
files_hint: [src/auth/, tests/test_auth.py]   # scheduler serializes overlapping tasks
depends_on: []
priority: 1                 # lower runs first
max_retries: 2
budget: { timeout_min: 30, max_turns: 50 }
verify:
  - pytest tests/test_auth.py -q
---

## Context
The refresh token silently expires when...

## Success criteria (must be executable)
- `pytest tests/test_auth.py` passes, including a new regression test

## Out of scope
- Do not touch the OAuth login flow
```

Rules that make agents effective:

- **Self-contained**: the agent sees only this text plus the repo.
- **Executable success criteria**: a command that says green/red — the verify gate runs it.
- **Explicit out-of-scope**: prevents opportunistic refactoring.
- `files_hint` powers anti-collision: two tickets whose hints overlap never run in
  parallel. A ticket without hints conservatively collides with everything in its repo.

## Configuration (`factory.yaml`)

All optional — missing file means defaults. See [`examples/factory.yaml`](examples/factory.yaml).

| Key | Default | Notes |
|---|---|---|
| `concurrency.max_slots` | `3` | **User parameter, no hard ceiling.** 3 is sane on a subscription; raise it freely on API. The rate-limit handler is the safety net, not this number. Override per run: `--slots N`. |
| `concurrency.stagger_seconds` | `20` | Staggered starts smooth out rate-limit pressure. |
| `agent.command` | `claude` | Any CLI with the same contract works — tests use a stub. |
| `agent.permission_mode` | `acceptEdits` | Never use permission bypass outside a disposable container. |
| `agent.allowed_tools` | git/pytest/ruff | Headless agents can't answer prompts; anything not allow-listed is denied. |
| `verify.commands` | `[]` | Default gate commands; tickets can override. |
| `ratelimit.cooldown_min` | `20` | First pause; doubles on each subsequent hit. |
| `contract_path` | built-in | The execution contract prepended to every prompt. |

## How a task flows

```
QUEUED → RUNNING → VERIFYING → MERGE_QUEUED → MERGING → DONE
            │           │                        │
            │           └── red ──► retry (failure evidence appended to the
            │                        ticket, max_retries) ──► FAILED
            ├── timeout/budget ──► retry/FAILED
            ├── rate limit ──► global pause, task requeued WITHOUT penalty
            └── agent asks a question ──► BLOCKED (human decision needed)
```

Every transition is one line in `runs/<run>/events.jsonl` — append-only, single writer,
crash-tolerant. `factory status` and `factory report` replay it; so can anything else
(a dashboard tails the same file — planned, see roadmap).

## Testing (no tokens required)

The full pipeline — dispatcher, worktrees, verification, merge queue, retries, rate-limit
pauses — is exercised end-to-end against **real git repositories** with a stub agent
(`tests/stub_agent.py`) standing in for the `claude` CLI:

```bash
pip install -e ".[dev]"
pytest -q
ruff check .
```

CI runs the suite on Linux **and** Windows.

## Design decisions

- **Prompt over stdin, not argv** — ticket size is never limited by OS argument-length caps.
- **The event log is the only state** — the dispatcher is the single writer; readers attach
  and detach freely. Crash mid-write leaves at most one torn line, which replay tolerates.
- **Verify after rebase, not just before** — a branch that was green in isolation may be red
  once its siblings landed. The merge queue re-proves every branch against moved base.
- **A rate-limit kill is not a retry** — the task did nothing wrong; it re-enters the queue
  intact while the dispatcher pauses globally.
- **Conservative collision default** — no `files_hint` means "assume it touches everything".
  Correctness over throughput.

## Limitations (honest)

- The merge queue targets the branch checked out in the target repo; the repo must be clean
  and on the base branch (`factory run` preflights this and refuses otherwise).
- Anti-collision is prefix-based on declared hints — it trusts the ticket author.
- No adversarial review agent yet, no dashboard yet (both specced for v2).
- `verify` commands run with your OS shell semantics; keep them portable if your team is
  cross-platform.

## Roadmap

- **v2** — adversarial review agent on the diff (second model, cheap tier), live dashboard
  (FastAPI + SSE tailing `events.jsonl`), post-worktree setup hooks (`uv sync`, `npm ci`).
- **v3** — burst mode, PR-based flow (`gh`), pluggable agent runtimes.

## License

MIT
