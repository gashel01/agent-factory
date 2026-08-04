"""Hardened Docker isolation for the coding agent (opt-in, `isolation: sandbox`).

The default `direct` runner spawns `claude` as a host subprocess in its worktree.
That gives the agent full host filesystem and network access — fine on your own
machine, but the CLI allowlist cannot contain it (`Bash(python:*)` alone is
arbitrary code execution). `sandbox` wraps the *same* `claude -p` invocation in a
`docker run` that:

- mounts ONLY the task's worktree (rw at /workspace); the rest of the host FS is
  invisible to the agent;
- mounts the subscription OAuth token read-only (no API key ever enters the box);
- drops all Linux capabilities, forbids privilege escalation, caps CPU/RAM/PIDs;
- routes egress through an allow-list proxy so the agent reaches Anthropic and
  nothing else — even though `python:*` still runs, it cannot phone home.

Everything here shells out to the `docker` CLI (no SDK dependency), mirroring how
the rest of the factory stays dependency-light. Proven end-to-end before wiring:
FS confinement, OAuth-in-container, live bind-mount, and egress deny all verified.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

# Image + infra names are stable so the proxy/networks are reused across runs and
# across factory restarts (created once, idempotently).
AGENT_IMAGE = "agent-factory-sandbox:latest"
PROXY_IMAGE = "agent-factory-egress:latest"
NET_INTERNAL = "agent-factory-internal"  # --internal: no direct route to the internet
NET_EGRESS = "agent-factory-egress"  # bridge with internet, only the proxy sits on it
PROXY_NAME = "agent-factory-proxy"
PROXY_PORT = 8888

# Where the container looks for the logged-in subscription token. Mounted read-only
# from the host so the box authenticates as whoever `claude` is logged in as.
CREDS_TARGET = "/root/.claude/.credentials.json"

# Resource ceilings for one agent container. Generous enough for real builds,
# bounded enough that a runaway can't starve the host.
MEM_LIMIT = "2g"
CPU_LIMIT = "2"
PIDS_LIMIT = "256"


class SandboxError(RuntimeError):
    """Docker isn't ready, or infra could not be brought up. Message is operator-actionable."""


def _docker() -> str:
    exe = shutil.which("docker")
    if exe is None:
        raise SandboxError(
            "docker CLI not found on PATH — install Docker Desktop to use sandbox isolation."
        )
    return exe


def _run(args: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    """Run a docker command, capturing output. Never raises on non-zero — callers
    inspect returncode — so a missing container/network reads as a status, not a crash."""
    return subprocess.run(
        [_docker(), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def credentials_path() -> Path:
    """The host OAuth token file mounted into the container."""
    return Path.home() / ".claude" / ".credentials.json"


def _docker_path(p: Path) -> str:
    """A path string Docker Desktop accepts for -v on Windows (forward slashes)."""
    return str(p).replace("\\", "/")


# ------------------------------------------------------------------ preflight

def preflight() -> dict:
    """Structured readiness the cockpit polls before offering/starting a sandbox run.

    Returns keys the dashboard renders directly:
      engine   — is the Docker daemon reachable?
      image    — is the agent image built?
      proxy    — is the egress proxy image built AND running?
      ready    — all of the above (a run can start now)
    Plus a short human `detail` when something is missing.
    """
    if shutil.which("docker") is None:
        return {"engine": False, "image": False, "proxy": False, "ready": False,
                "detail": "Docker CLI not installed"}
    try:
        info = _run(["info", "--format", "{{.ServerVersion}}"], timeout=15.0)
    except subprocess.TimeoutExpired:
        return {"engine": False, "image": False, "proxy": False, "ready": False,
                "detail": "Docker engine not responding (is Docker Desktop started?)"}
    if info.returncode != 0:
        return {"engine": False, "image": False, "proxy": False, "ready": False,
                "detail": "Docker engine not started"}
    has_agent = _image_exists(AGENT_IMAGE)
    has_proxy_image = _image_exists(PROXY_IMAGE)
    proxy_running = _container_running(PROXY_NAME)
    ready = has_agent and has_proxy_image and proxy_running
    detail = ""
    if not has_agent or not has_proxy_image:
        detail = "Sandbox image not built yet"
    elif not proxy_running:
        detail = "Egress proxy not started"
    return {
        "engine": True,
        "image": has_agent,
        "proxy": has_proxy_image and proxy_running,
        "ready": ready,
        "detail": detail,
    }


def _image_exists(name: str) -> bool:
    return _run(["image", "inspect", name]).returncode == 0


def _container_running(name: str) -> bool:
    out = _run(["ps", "--filter", f"name=^{name}$", "--filter", "status=running",
                "--format", "{{.Names}}"])
    return name in out.stdout


def _network_exists(name: str) -> bool:
    return _run(["network", "inspect", name]).returncode == 0


# ------------------------------------------------------------------ infra

def ensure_infra() -> None:
    """Bring up the networks and egress proxy if they aren't already. Idempotent and
    cheap after the first call (the proxy is long-lived, reused across runs).

    Does NOT build images — that's a slower, explicit step surfaced in the cockpit
    (Build button) so a run never silently blocks on a multi-minute build. Raises
    SandboxError with an actionable message if the engine or images aren't ready."""
    status = preflight()
    if not status["engine"]:
        raise SandboxError(status["detail"] or "Docker engine not available")
    if not status["image"]:
        raise SandboxError(
            f"sandbox image '{AGENT_IMAGE}' not built — build it from the cockpit "
            "(or run scripts/build-sandbox)."
        )
    if not _image_exists(PROXY_IMAGE):
        raise SandboxError(
            f"egress proxy image '{PROXY_IMAGE}' not built — build it from the cockpit."
        )

    # Networks: internal (no internet) for the agent, egress (bridge) for the proxy.
    if not _network_exists(NET_INTERNAL):
        _run(["network", "create", "--internal", NET_INTERNAL])
    if not _network_exists(NET_EGRESS):
        _run(["network", "create", NET_EGRESS])

    if not _container_running(PROXY_NAME):
        # Clear a stopped/stale one first, then start fresh on the internal net and
        # attach the egress net so it (and only it) can reach the internet.
        _run(["rm", "-f", PROXY_NAME])
        started = _run([
            "run", "-d", "--name", PROXY_NAME, "--restart", "unless-stopped",
            "--network", NET_INTERNAL, PROXY_IMAGE,
        ])
        if started.returncode != 0:
            raise SandboxError(f"could not start egress proxy: {started.stderr.strip()[:200]}")
        _run(["network", "connect", NET_EGRESS, PROXY_NAME])
        _wait_proxy_ready()


def _repo_root() -> Path:
    """The agent-factory repo root, from this file's location (src/factory/sandbox.py)."""
    return Path(__file__).resolve().parents[2]


def build() -> None:
    """Build both sandbox images. Streams docker's own output to stdout (inherited),
    so when the dashboard spawns `factory sandbox-build` the build log is live in the
    job panel. Raises SandboxError on failure with the failing image named."""
    root = _repo_root() / "sandbox"
    for tag, context in ((AGENT_IMAGE, root), (PROXY_IMAGE, root / "proxy")):
        print(f"Building {tag} …", flush=True)
        proc = subprocess.run([_docker(), "build", "-t", tag, str(context)])
        if proc.returncode != 0:
            raise SandboxError(f"docker build failed for {tag} (exit {proc.returncode})")
    print("Sandbox images ready.", flush=True)


def _wait_proxy_ready(timeout_s: float = 10.0) -> None:
    """Give tinyproxy a moment to bind. Bounded; a not-quite-ready proxy just means
    the first request retries at the TCP layer, so this is best-effort."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _container_running(PROXY_NAME):
            return
        time.sleep(0.3)


# ------------------------------------------------------------------ wrap

def wrap(base_cmd: list[str], worktree_path: Path) -> list[str]:
    """Turn the host `claude -p …` argv into a hardened `docker run … claude -p …`.

    base_cmd[0] is the host-resolved claude executable (dropped — the container has
    its own `claude` on PATH); base_cmd[1:] are the CLI flags, which are all
    container-agnostic. A host-only `--mcp-config <path>` (ragmcp knowledge base)
    is stripped: that server lives on the host and isn't reachable from the box —
    knowledge-base + sandbox is a documented follow-up, not a silent broken run.
    """
    args = _strip_host_only_flags(base_cmd[1:])
    creds = _docker_path(credentials_path())
    wt = _docker_path(worktree_path)
    proxy = f"http://{PROXY_NAME}:{PROXY_PORT}"
    return [
        _docker(), "run", "--rm", "-i",
        # egress: internal net only, forced through the allow-list proxy
        "--network", NET_INTERNAL,
        "-e", f"HTTP_PROXY={proxy}", "-e", f"HTTPS_PROXY={proxy}",
        "-e", f"http_proxy={proxy}", "-e", f"https_proxy={proxy}",
        # privilege + resource hardening
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", PIDS_LIMIT,
        "--memory", MEM_LIMIT,
        "--cpus", CPU_LIMIT,
        # only the worktree is visible; auth token mounted read-only
        "-v", f"{wt}:/workspace",
        "-v", f"{creds}:{CREDS_TARGET}:ro",
        "-w", "/workspace",
        # let the agent's `git commit` work inside the box (see _git_args)
        *_git_args(worktree_path),
        AGENT_IMAGE,
        "claude", *args,
    ]


def _git_args(worktree_path: Path) -> list[str]:
    """Docker args that make the agent's git operations work inside the container.

    A factory worktree is a LINKED worktree: its `.git` is a file pointing at
    `<main-repo>/.git/worktrees/<id>`, which lives OUTSIDE the mounted worktree. So
    git in the box can't find it. We mount the main `.git` and point git at it via
    GIT_DIR/GIT_WORK_TREE env — no file rewrite, so host git keeps using its own
    (Windows) paths unchanged. The host `.gitconfig` is mounted read-only so commits
    carry the same identity as a direct run, and safe.directory is relaxed so the
    cross-uid bind mount isn't rejected as 'dubious ownership'.
    """
    args: list[str] = []
    dotgit = worktree_path / ".git"
    try:
        text = dotgit.read_text(encoding="utf-8").strip() if dotgit.is_file() else ""
    except OSError:
        text = ""
    if text.startswith("gitdir:"):
        gitdir = Path(text.split(":", 1)[1].strip())
        common = gitdir.parent.parent  # <main-repo>/.git
        wt_id = gitdir.name
        args += [
            "-v", f"{_docker_path(common)}:/repo/.git",
            "-e", f"GIT_DIR=/repo/.git/worktrees/{wt_id}",
            "-e", "GIT_WORK_TREE=/workspace",
        ]
    gitconfig = Path.home() / ".gitconfig"
    if gitconfig.is_file():
        args += ["-v", f"{_docker_path(gitconfig)}:/root/.gitconfig:ro"]
    # Additive (does not replace the mounted .gitconfig): trust the bind-mounted tree.
    args += [
        "-e", "GIT_CONFIG_COUNT=1",
        "-e", "GIT_CONFIG_KEY_0=safe.directory",
        "-e", "GIT_CONFIG_VALUE_0=*",
    ]
    return args


def run_command(
    cmd: str, worktree_path: Path, *, allow_network: bool, timeout_s: int,
) -> tuple[int, str]:
    """Run ONE shell command inside the hardened box against the worktree, and
    return (returncode, combined output). Raises subprocess.TimeoutExpired on
    timeout so callers handle it uniformly with the host path.

    Used for the setup and verify phases (NOT the agent). No auth token is mounted
    here — these phases never talk to Anthropic — so a malicious dependency or an
    agent-authored test can't read the subscription token. `allow_network` gates
    egress: True (bridge) for setup, since dependency installs (uv/npm) need pypi/
    npm and the commands are trusted operator config; False (--network none) for
    verify, since it runs the agent's own test code — offline, it cannot exfiltrate.
    """
    net = ["--network", "bridge"] if allow_network else ["--network", "none"]
    proc = subprocess.run(
        [
            _docker(), "run", "--rm",
            *net,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", PIDS_LIMIT, "--memory", MEM_LIMIT, "--cpus", CPU_LIMIT,
            "-v", f"{_docker_path(worktree_path)}:/workspace", "-w", "/workspace",
            *_git_args(worktree_path),
            AGENT_IMAGE, "bash", "-c", cmd,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout_s,
    )
    return proc.returncode, proc.stdout + proc.stderr


def _strip_host_only_flags(args: list[str]) -> list[str]:
    """Drop flags whose values are host paths meaningless inside the container."""
    out: list[str] = []
    skip_next = False
    for a in args:
        if skip_next:
            skip_next = False
            continue
        if a == "--mcp-config":
            skip_next = True  # also drop its path argument
            continue
        if a == "--strict-mcp-config":
            continue
        out.append(a)
    return out
