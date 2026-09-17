# Contributing

Thanks for your interest in agent-factory. This is a small, focused project;
contributions that keep it lean and well-tested are very welcome.

## Development setup

Requires Python >= 3.11, `git`, and the `claude` CLI on your PATH.

```bash
# with uv (recommended)
uv sync --extra dev
uv run factory --help

# or with pip
pip install -e ".[dev]"
factory --help
```

## Before you open a PR

Run the checks locally and make sure they pass:

```bash
# lint
ruff check .

# tests
pytest
```

Some tests exercise the sandbox and end-to-end paths and expect Docker and the
`claude` CLI to be available; if they are not on your machine, note which suites
you were unable to run in your PR description.

## Guidelines

- **Keep the scope tight.** One change per PR; no opportunistic refactoring
  mixed into a feature or fix.
- **Add tests** for new behaviour, and keep the existing suite green.
- **Commit style** follows Conventional Commits: `feat:`, `fix:`, `refactor:`,
  `docs:`, `test:`, `chore:`.
- **Style** is enforced by `ruff` (line length 100). Run it before pushing.

## Reporting bugs

Open an issue with a minimal reproduction: what you ran, what you expected, and
what happened. Logs from `events.jsonl` are usually the fastest way to diagnose a
run.
