"""Deterministic oversized-file detection: a token-free pre-scan.

A file big enough that reading it whole dominates a ticket's budget is the top
token sink in a factory run (a 278 KB monolith costs ~70k tokens to read cold).
Detecting them needs no LLM and no tokens: file SIZE is a direct token-cost
proxy, weighted by how often the file CHANGES — a big file nobody edits costs
nothing, so it should not distract from the ones that hurt. The planner reads
the result and proposes a split when its work lands on a hotspot; the operator
sees the list at a glance. Detection is deterministic (this module); the
decision to split stays with the planner and the operator.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

# Hand-editable source only. A generated bundle, lockfile, data blob, or vendored
# dependency is never worth splitting, so allow-list the extensions a human
# actually edits — an allow-list has far fewer false positives than trying to
# enumerate every generated artefact to skip.
SOURCE_EXTENSIONS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".css", ".scss", ".less",
    ".vue", ".svelte", ".sql",
})

# Even with a source extension, these name markers are generated/minified and
# must never be flagged — a *.min.js is not something a human splits.
SKIP_SUBSTRINGS = (".min.", ".bundle.", ".generated.", "-lock.", ".lock.")

# ~4 bytes per token is the usual rough proxy for source code; good enough to rank.
_BYTES_PER_TOKEN = 4

# Default gate: a file whose full read would cost this many tokens or more is a
# hotspot. ~15000 tokens ~= 60 KB ~= 1800+ lines of source. Deliberately high: the
# real monoliths this was built for were 147 KB and 278 KB; a well-factored
# 40-50 KB module (~750-1000 lines) is healthy and must NOT be nagged. The panel
# fires only when a file genuinely bloats past that, not for every large module.
DEFAULT_MIN_TOKENS = 15000

# How much recent history to weigh when judging "how central is this file".
_RECENT_COMMITS = 200


@dataclass(frozen=True)
class Hotspot:
    path: str          # repo-relative, forward slashes (git's own form)
    size_bytes: int
    est_tokens: int
    edits: int         # times touched in the last _RECENT_COMMITS commits
    score: float       # est_tokens * (1 + edits): size weighted by churn

    def label(self) -> str:
        kb = self.size_bytes / 1024
        return (
            f"{self.path} — ~{self.est_tokens // 1000}k tokens "
            f"({kb:.0f} KB, {self.edits} recent edits)"
        )


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return proc.stdout if proc.returncode == 0 else ""


def _tracked_files(repo: Path) -> list[str]:
    # Tracked files only: respects .gitignore and skips build output / untracked
    # cruft for free. One git call.
    return [line.strip() for line in _git(repo, "ls-files").splitlines() if line.strip()]


def _edit_counts(repo: Path) -> dict[str, int]:
    # One git call: how many of the last N commits touched each path. Churn is our
    # proxy for centrality — a hot file is worth splitting, a big-but-frozen one
    # much less.
    out = _git(repo, "log", f"-n{_RECENT_COMMITS}", "--name-only", "--pretty=format:")
    counts: dict[str, int] = {}
    for line in out.splitlines():
        path = line.strip()
        if path:
            counts[path] = counts.get(path, 0) + 1
    return counts


def _is_candidate(rel_path: str) -> bool:
    lower = rel_path.lower()
    if any(marker in lower for marker in SKIP_SUBSTRINGS):
        return False
    return Path(lower).suffix in SOURCE_EXTENSIONS


def scan_hotspots(
    repo: Path, *, min_tokens: int = DEFAULT_MIN_TOKENS, limit: int = 10
) -> list[Hotspot]:
    """Rank the repo's oversized hand-editable source files, biggest-and-hottest
    first. Pure filesystem + git metadata — no file CONTENTS are read, so it is
    cheap and token-free. Empty when the path is not a git repo."""
    if not (repo / ".git").exists():
        return []
    edits = _edit_counts(repo)
    hotspots: list[Hotspot] = []
    for rel in _tracked_files(repo):
        if not _is_candidate(rel):
            continue
        try:
            size = (repo / rel).stat().st_size
        except OSError:
            continue
        est = size // _BYTES_PER_TOKEN
        if est < min_tokens:
            continue
        n = edits.get(rel, 0)
        hotspots.append(
            Hotspot(path=rel, size_bytes=size, est_tokens=est, edits=n, score=est * (1 + n))
        )
    hotspots.sort(key=lambda h: h.score, reverse=True)
    return hotspots[:limit]


def brief_for_planner(hotspots: list[Hotspot]) -> str:
    """A short prompt section the planner reads so it proposes a split when its
    work lands on one of these files. Empty when there are none."""
    if not hotspots:
        return ""
    lines = [
        "# Oversized files in this repo (a deterministic size scan)",
        "",
        "These files are large; reading one in full can weigh on a ticket's token "
        "budget. If your plan's work touches one, consider splitting it FIRST into "
        "smaller modules (as its own ticket that nothing else depends on file-wise), "
        "or scope the edit tightly with files_hint. Do NOT split a file your goal "
        "does not touch.",
        "",
    ]
    lines.extend(f"- {h.label()}" for h in hotspots)
    return "\n".join(lines)
