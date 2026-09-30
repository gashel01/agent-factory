# Warden

Run a fleet of parallel [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents
over a task backlog — with git-worktree isolation, deterministic verification gates, and a
sequential merge queue. **Works on a Claude subscription (no API key)**, on Windows, macOS,
and Linux.

> ⚠️ **Work in progress.** Warden is under active development and will keep
> changing as I test it against more project types. Expect the API, the CLI and
> the dashboard to move. Feedback and issues are welcome.

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
  gate proves it (real commits + success-criteria commands exit 0, test machinery
  untouched), re-proven **after** rebase.
- **Budgets** — every task carries a wall-clock timeout and a max-turns cap; a run never
  bleeds cost silently.
- **Rate limits** — on a subscription plan, limits are a fact of life. The dispatcher pauses
  globally with exponential backoff, requeues the interrupted task *without* penalty, and
  stops cleanly (backlog intact) if the quota is truly exhausted.

## Quickstart

```bash
# 1. install (Python >= 3.11, git and the claude CLI on PATH)
uv sync            # recommended
# or: pip install -e .

# 2. describe work as tickets
mkdir backlog && $EDITOR backlog/001-fix-auth.md   # see "Ticket format" below

# 3. sanity-check the schedule (parses everything, launches nothing)
factory run --dry-run

# 4. go — 3 parallel agents by default, your call entirely
factory run --slots 3
factory status
factory report
```

## Co-create tickets with an agent (`factory plan`)

You never have to write ticket markdown by hand. Give the goal in one sentence;
a single **read-only** planning agent explores the repo and drafts the tickets —
scoped files, dependencies, executable success criteria:

```bash
factory plan "Migrate all HTTP calls from requests to httpx, keep the tests green" --repo ../myproject
# → drafts written to backlog/, IDs numbered after any existing tickets
factory run --dry-run     # review the schedule, edit or delete drafts freely
factory run
```

The planner proposes, you dispose: drafts are ordinary ticket files, never
executed without your review. If the goal is too vague, the planner refuses
and asks you a precise question instead of guessing. If the repo has no test
setup, it makes ticket 001 "set up the test harness" and chains the rest on it.

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
| `concurrency.max_slots` | `2` | **User parameter, no hard ceiling.** 2 is calm on a subscription (every agent shares one plan bucket with your own Claude Code); raise it freely on API. The rate-limit handler is the safety net, not this number. Override per run: `--slots N`. |
| `concurrency.stagger_seconds` | `20` | Staggered starts smooth out rate-limit pressure. |
| `concurrency.candidates` | `1` | **Best-of-N.** Independent agents per ticket on its first attempt, each in its own worktree and slot; the verified candidate with the smallest diff wins. Tickets override with `candidates: N`. N× the tokens for a better first-try hit rate. |
| `concurrency.blocked_wait_min` | `60` | Tickets that depend on a BLOCKED one wait this long for your answer before being left for a later run. |
| `agent.command` | `claude` | Any CLI with the same contract works — tests use a stub. |
| `agent.permission_mode` | `acceptEdits` | Never use permission bypass outside a disposable container. |
| `agent.allowed_tools` | git/pytest/ruff | Headless agents can't answer prompts; anything not allow-listed is denied. |
| `setup.commands` | `[]` | Run in each fresh worktree **before** the agent starts (`uv sync`, `npm ci`, …). Worktrees share no venv/node_modules with the main checkout — any repo with dependencies needs this. Setup failure fails the task immediately (environment problem, no retries burned). |
| `verify.commands` | `[]` | Default gate commands; tickets can override. |
| `verify.require_commands` | `true` | A ticket with no success-criteria command at all is **not** DONE — a diff proves nothing works. Opt a single ticket out with `skip_verify: true`. |
| `verify.protected` | test/CI config | Globs the agent must not change unless its ticket's `files_hint` names them (`conftest.py`, `pytest.ini`, jest/vitest config, `.github/**`…). Deleting an existing test file fails too. `[]` disables. |
| `review.enabled` | `false` | Adversarial second agent judging each diff before merge (scope creep, gamed tests, obvious bugs). Rejection re-queues the task with the reasons as evidence. Use `review.model` for a cheap tier. The review's cost counts against the budget. |
| `review.on_failure` | `hold` | A review with **no verdict** (timeout, crash, unreadable) is retried `review.attempts` times, then: `hold` parks the ticket for your approval, `reject` sends it back, `approve` merges on the verify gate alone. It never silently counts as an approval. |
| `ratelimit.cooldown_min` | `20` | First pause; doubles on each subsequent *episode*. When the CLI announces the reset time, Warden waits for exactly that instead. |
| `ratelimit.max_wait_min` | `330` | A reset further away than this (a weekly cap) stops the run cleanly, backlog intact, instead of idling for days. |
| `contract_path` | built-in | The execution contract prepended to every prompt. |

## How a task flows

```
QUEUED → RUNNING → VERIFYING → (REVIEWING) → MERGE_QUEUED → MERGING → DONE
            │           │            │             │
            │           │            │             └── conflicts with the moved base ──►
            │           │            │                 agent resumes mid-merge to resolve
            │           │            └── no verdict ──► AWAITING_APPROVAL (you decide)
            │           └── red ──► retry (failure evidence appended to the
            │                        ticket, max_retries) ──► FAILED
            ├── timeout/budget ──► retry/FAILED
            ├── rate limit ──► global pause, task requeued WITHOUT penalty
            └── agent asks a question ──► BLOCKED (human decision needed;
                                          its dependents wait for your answer)
```

Every transition is one line in `runs/<run>/events.jsonl` — append-only, single writer,
crash-tolerant, each event carrying a sequence number and a millisecond timestamp.
`factory status` and `factory report` replay it; the dashboard tails the same file.
Every agent attempt keeps its own transcript (`agents/<id>.stdout.jsonl`, earlier
attempts as `…attempt<N>.jsonl`).

**One run at a time, and crashes are recoverable.** `factory run` takes a lock per
workspace (`runs/.factory.lock`, which the dashboard also honours) and per
repository. A run killed without shutting down (power loss, `kill -9`) is closed out
by the next `factory run` — or explicitly with `factory recover`: its log gets a
`run_end` marked `crashed`, its worktrees are removed, and any task branch that
already holds commits is **continued** by the next run instead of redone.

## Live dashboard

A TypeScript status board and cockpit (Node >= 20, zero runtime dependencies)
that tails `events.jsonl` over SSE — attach to a live run, watch a new run take
over automatically, or replay a finished one — and drives the factory from the
browser.

```bash
cd dashboard
npm install && npm run build
npm start -- --workdir <workspace>   # http://127.0.0.1:8765
```

`--workdir` is the workspace directory (the one holding `factory.yaml`,
`backlog/` and `runs/`); other workspaces can be registered from the UI.

It is **not** read-only: it writes operator commands to a run's `control.jsonl`
(pause, stop, answer, approve…), stores uploads and attachments, edits
`factory.yaml`, backlog tickets and memory, and launches `factory plan` /
`factory run` / `factory loop` as child processes. It refuses to start a run
while another one holds the workspace (`runs/.factory.lock`).

**Auth.** On first launch the server creates a per-install token
(`<workdir>/.dashboard-token`) and prints `http://localhost:8765/?token=…`; open
that URL once and the browser keeps it. Every mutating request needs the token
(`x-factory-token` header, or `?token=`), and the `Host` header must name this
machine (DNS-rebinding guard).

**`--host`.** The default `127.0.0.1` keeps it local, where read-only requests
need no token. `--host 0.0.0.0` exposes it on the LAN (for the phone QR, which
carries the token): then *every* `/api` request needs the token, except the
built-APK download. Only do this on a network you trust — anyone holding the
token can run agents on your machine.

Header badge (live / paused on rate limit / finished), stat tiles, one card per
task (state chip, turns, duration, retries, failure evidence, agent-log viewer),
and the raw event feed. Light and dark theme, status colors always paired with
an icon + label.

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

## Safety model

Two isolation levels, and an honest line between them:

- **`direct`** (default): each agent is a host process in its worktree. Anything the
  allow-list admits runs with your user's rights — `Bash(python:*)` alone is
  arbitrary code. What protects you here is against *accidents*, not malice: a
  `PreToolUse` guard hook (`src/factory/agent_hooks.py`) sees **every** tool call,
  allow-listed or not, and blocks history-destroying git (`reset --hard`, `rebase`,
  `push --force`, `clean`, `branch -D`, …) and writes into `.git` — however the
  command is wrapped (`bash -c "…"`, a Python `subprocess.run([...])`). The agent is
  told why and asked to report `blocked` instead. A text scan can still be evaded
  on purpose; that is what the sandbox is for.
- **`sandbox`** (`execution.isolation: sandbox`, needs Docker): the same `claude -p`
  runs in a hardened container — capabilities dropped, no privilege escalation,
  CPU/RAM/PID caps, only its worktree mounted, egress forced through an allow-list
  proxy that admits Anthropic and nothing else. The host repository's `.git` is
  **never mounted**: git in the box works on a throwaway repository in a tmpfs that
  reads the host's objects read-only, and the agent's commits come back as a
  `git bundle` the host fetches — inert data, so nothing the agent writes can become
  a hook, a config entry or a rewritten ref on your machine. Setup, verify, the
  post-rebase re-verify and the integration check run in the box too (verify and
  re-verify offline). Containers are named and killed on timeout or operator kill.

Beyond isolation: the reviewer receives the diff fenced as untrusted data; the
supervisor reads agents' summaries as data and cannot write the control channel
(its run commands are one-click suggestions you apply); the verify gate refuses a
ticket that edits the test machinery it is judged by.

## Design decisions

- **Prompt over stdin, as stream-json** — ticket size is never limited by OS
  argument-length caps, and the CLI waits for the message however long the spawn
  takes (in plain-text mode it gives stdin ~3 s, which capped parallel starts).
- **The event log is the only state** — the dispatcher is the single writer; readers attach
  and detach freely. Crash mid-write leaves at most one torn line, which replay tolerates.
- **Verify after rebase, not just before** — a branch that was green in isolation may be red
  once its siblings landed. The merge queue re-proves every branch against moved base.
- **A rate-limit kill is not a retry** — the task did nothing wrong; it re-enters the queue
  intact while the dispatcher pauses globally. One episode counts once, however many
  slots hit it, and a success resets the streak.
- **No verdict is not an approval** — a reviewer that crashes or times out never lets a
  change through by default; you decide (`review.on_failure`).
- **Kill the tree, not the process** — a timeout or kill reaches everything the agent
  started (test runners, dev servers), and a sandboxed agent's container.
- **Conservative collision default** — no `files_hint` means "assume it touches everything".
  Correctness over throughput.

## Limitations (honest)

- The merge queue targets the branch checked out in the target repo; the repo must be clean
  and on the base branch (`factory run` preflights this and refuses otherwise).
- Anti-collision is prefix-based on declared hints — it trusts the ticket author.
- In `direct` mode the guard hook stops accidents, not a determined agent; use `sandbox`
  for untrusted tickets or repositories.
- In `sandbox` mode the agent's *uncommitted* edits stay in its worktree, but only
  commits travel through the bundle; the project knowledge base (ragmcp MCP server)
  is not reachable from the box.
- The tamper check covers test/CI configuration and deleted test files; a weakened
  assertion inside a test the ticket may edit is left to the reviewer.
- `verify` commands run with your OS shell semantics; keep them portable if your team is
  cross-platform.

## Roadmap

- measured resolve rate on a non-cherry-picked SWE-bench Verified sample (harness in
  `benchmarks/swebench/`), bare vs full pipeline
- OpenTelemetry export of the event stream
- pluggable agent runtimes beyond the Claude Code CLI

## License

MIT
