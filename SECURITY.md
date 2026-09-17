# Security Policy

## Reporting a vulnerability

If you find a security issue, please report it privately rather than opening a
public issue. Email **gaelibz@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce, and
- any relevant logs or proof of concept.

You can expect an acknowledgement within a few days. Please give a reasonable
window to address the issue before any public disclosure.

## Scope and design notes

agent-factory runs autonomous coding agents. A few things worth knowing:

- **Agents run generated code.** By design, agent work is isolated in per-task
  git worktrees, and the optional sandbox runs code with reduced privileges
  (dropped capabilities, a workspace-only filesystem, and a default-deny network
  egress allowlist). Review the sandbox configuration before pointing the factory
  at untrusted tasks.
- **Credentials.** The tool uses your local `claude` CLI session; it does not
  store API keys. Never commit `.env`, tokens, or workspace state — these are
  already covered by `.gitignore`.
- **Untrusted input.** Treat any ticket or document content an agent reads as
  untrusted data, not as instructions.

## Supported versions

This project is pre-1.0; only the latest `main` is supported.
