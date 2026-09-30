# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning once it reaches 1.0. Until then, expect breaking changes
between releases.

## [Unreleased] — Reliability & safety hardening

### Safety
- **Sandbox no longer mounts the host repository's `.git`.** git inside the box
  runs on a throwaway repository (tmpfs) reading the host objects read-only; the
  agent's commits return as a `git bundle` the host fetches. Nothing an agent
  writes can become a hook, config entry or rewritten ref on the host.
- In sandbox mode, the post-rebase re-verify and the integration check now run in
  the box too (previously on the host, with network).
- Containers are named and killed on timeout/kill; host agents are killed as a
  whole process tree (POSIX process group, `taskkill /T` on Windows).
- New `PreToolUse` guard hook on every agent tool call: blocks destructive git and
  writes into `.git` however the command is wrapped.
- Egress allow-list reduced to Anthropic (`sentry.io` / `statsig.com` removed; the
  CLI's non-essential traffic is disabled in the box). **Rebuild the proxy image.**
- Reviewer sees the diff fenced as untrusted data; the supervisor can no longer
  write `control.jsonl` (run commands are one-click suggestions) and reads the run
  snapshot as data.
- Git never waits for a credential prompt and every git call has a timeout; git
  commands in agent worktrees run with fsmonitor/submodule recursion disabled and
  the worktree's `.git` pointer restored first.

### Reliability
- Prompts are sent as stream-json (`--input-format stream-json`): the CLI no longer
  aborts when stdin is slower than ~3 s, which capped parallel starts at two slots.
- Run lock per workspace (`runs/.factory.lock`) and per repository; crash recovery
  (`factory recover`, automatic on `factory run`) closes dead runs and continues
  their task branches that hold commits.
- Rate limits: one episode counts once across slots, a success resets the streak,
  the announced reset time is honoured, and a far-away reset stops cleanly.
- A stderr "overloaded" warning no longer discards a successful result.
- Dependents of a BLOCKED ticket wait for the operator's answer (bounded by
  `concurrency.blocked_wait_min`) instead of failing.
- Merge conflicts with a moved base: the dispatcher merges the base into the task
  branch and, on conflicts, resumes the agent mid-merge with instructions (it was
  asked to resolve a rebase it is forbidden to run).
- Worktree removal is verified and retried (Windows file locks); leftovers are
  cleared before a retry recreates the worktree.

### Trust in DONE
- `verify.require_commands` (default **on**): no success-criteria command, no DONE.
- Tamper check: changing test/CI config (`verify.protected`) or deleting a test file
  outside the ticket's `files_hint` fails verification.
- A review without a verdict is retried, then handled by `review.on_failure`
  (default `hold` for the operator) — never a silent approval. Review cost counts
  against the budget.
- Best-of-N (`concurrency.candidates` / ticket `candidates`).

### Observability
- Events carry a sequence number and millisecond timestamps; every attempt keeps
  its transcript; `agent_result` records the attempt and worktree.

### Dashboard
- Token required for every mutating method (PUT included) and for every `/api`
  GET when bound off-loopback; Host header validated; constant-time token check;
  body size limits; global error handling; `/api/repo/*` limited to known repos.
- Atomic writes, SSE heartbeat, child processes killed on shutdown, a run refused
  while `runs/.factory.lock` is held; error boundaries, hidden-tab polling pause,
  keyboard access; route tests; `npm test` in CI.
- Settings: default checks, "require a passing check", best-of-N, and the
  inconclusive-review policy.

### Planning
- **Quote the spec, never paraphrase it.** Each planned ticket carries the spec
  rules it implements, copied word for word (`spec`); Warden checks every quote
  against its source file and flags any paraphrase, the ticket opens with a
  "Spec (verbatim)" section, and agents and the reviewer treat those lines as the
  source of truth over the ticket's own wording. (A paraphrased rule let a ticket
  contradict the spec while its own tests passed.)
- Planner output with many nested braces (ticket bodies quoting API shapes) is
  parsed again — the contract JSON search is no longer capped at 50 candidates.
- Tickets, agent summaries, questions, commit messages and review reasons follow
  the language of the goal/ticket, not the operator's Claude language setting.

### Agents
- Agents, the planner, the reviewer and the doctor start with `--strict-mcp-config`:
  they no longer inherit the operator's own MCP servers (the supervisor opts out).
- `agent_result` records cache-write tokens; token counts everywhere include the
  prompt cache.

### Dashboard — new interface
- A new interface replaces the classic one and is served at `/` (`/next`
  redirects): board with Kanban/Focus, ticket sheet, pull requests, autopilot,
  repository, knowledge, run & preview, insights, memory, settings and a
  supervisor panel. The classic UI, its stylesheets and its bundle are removed.
- New projects require a starting model (Opus or Sonnet recommended, or Haiku),
  written to `agent.model`; a project without one is asked before its first run.
- Run estimate recalibrated on measured runs: a fixed per-agent context cost plus
  the ticket's size, current model prices including prompt-cache reads/writes, and
  the dependency chain for wall-clock time.
- The "add a dependency install to setup" warning only fires when the project's
  manifests or checks really need one.
- Draft cards show what they wait on, and the board links to the dependency graph
  whenever a ticket depends on another.
- Insights token totals include the prompt cache.

### Breaking
- Tickets with no verify command now fail verification unless `skip_verify: true`
  or `verify.require_commands: false`.
- `review` no longer fails open by default (`review.on_failure: approve` restores it).
- The classic dashboard UI is gone; bookmarks to `/next` redirect to `/`.

## [0.1.0] — First public release

First public, work-in-progress release of Warden: an autonomous coding factory
that plans, dispatches and reviews parallel [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
agents over a task backlog. Works on a Claude subscription (no API key), on
Windows, macOS and Linux.

### Core orchestration
- Dispatcher runs N agents in parallel, one **isolated git worktree + branch**
  per ticket, so agents never step on each other.
- **Deterministic verification gate**: work only counts once real commits exist
  and the ticket's success-criteria commands exit 0.
- **Sequential merge queue**: rebase → re-verify → merge, one at a time; diffs
  are compared against the merge-base (3-dot), and merges survive a dirty base
  by stashing and restoring the operator's WIP.
- **Budgets and rate limits**: per-ticket wall-clock timeout and max-turns cap;
  the dispatcher pauses globally with exponential backoff, requeues interrupted
  tickets without penalty, and stops cleanly with the backlog intact when quota
  is exhausted.
- `events.jsonl` append-only event log as the single source of truth.

### Autonomy and safety
- **Sandbox isolation** for agent-run code: dropped capabilities, a
  workspace-only filesystem, and a default-deny network egress allowlist.
- **Self-healing** of non-portable verification at load time, and a render-smoke
  test that proves components actually render.
- **Model + effort routing**: planner defaults to the cheapest tier and leans on
  escalation; per-ticket choice of coding model and reasoning effort.
- Review **fails open** on a reviewer crash rather than blocking the queue.
- Four work modes (single ticket, backlog, autopilot budget-as-tickets, and the
  iteration cap).

### Cockpit (dashboard)
- Real-time cockpit UI to launch, watch and steer runs.
- **Architecture tab**: a living system map drawn from the code, with
  click-to-isolate-flow and zoom/pan, plus the operator's own architecture notes
  that agents read.
- **Visual decision gate**: the agent asks, the operator picks, the run resumes.
- **Shared sketch board** and a coordination bus for multi-agent (Level 2-3)
  work, with a "shared space" view of claims and landings.
- Companion rail with file attachments (drag-drop, paste, image and non-image
  uploads).
- Per-project settings, project switcher, branch-scoped repo timeline (coloured
  git graph, commit compare), and an editable spec for failed/blocked tickets
  before retry.

### Observability and governance
- Cost, token and latency tracking with hard budget caps enforced before each
  call.
- Output-quality monitoring gates based on per-use-case parameters.
- Structured, replayable per-run traces.

### Tooling
- SWE-bench harness for measuring agents on real tasks.
- Optional semantic lesson recall via `fastembed` (falls back to a keyword
  ranker when absent).
- Cross-platform: Windows, macOS, Linux.

[0.1.0]: https://github.com/gashel01/agent-factory
