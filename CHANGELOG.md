# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning once it reaches 1.0. Until then, expect breaking changes
between releases.

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
