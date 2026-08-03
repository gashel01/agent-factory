# Hardened runtime that hosts one `claude -p` agent against a mounted worktree.
# Bakes the toolchain (node for the CLI, python+uv for the project) once; per-project
# deps install per-worktree via the factory's setup commands. See factory/sandbox.py.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-venv python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

# uv (Astral) for Python project deps
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
