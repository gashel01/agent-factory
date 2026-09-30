"""Hardened Docker isolation for the coding agent (opt-in, `isolation: sandbox`).

The default `direct` runner spawns `claude` as a host subprocess in its worktree.
That gives the agent full host filesystem and network access — fine on your own
machine, but the CLI allowlist cannot contain it (`Bash(python:*)` alone is
arbitrary code execution). `sandbox` wraps the *same* `claude -p` invocation in a
`docker run` that:

- mounts ONLY the task's worktree (rw at /workspace); the rest of the host FS is
  invisible to the agent;
- never mounts the host repository's `.git`. git inside the box works on a
  throwaway repository in a tmpfs, which reads the host's object store READ-ONLY
  (alternates). The agent's commits leave the box as a `git bundle` — inert data
  the host fetches — so nothing the agent writes can become a hook, a config
  entry or a rewritten ref that the host's own git would later honour;
- mounts the subscription OAuth token read-only (no API key ever enters the box);
- drops all Linux capabilities, forbids privilege escalation, caps CPU/RAM/PIDs;
- routes egress through an allow-list proxy so the agent reaches Anthropic and
  nothing else — even though `python:*` still runs, it cannot phone home;
- names every container, so a timeout or an operator kill stops the container
  itself (killing the `docker run` client alone leaves it running and spending).

Everything here shells out to the `docker` CLI (no SDK dependency), mirroring how
the rest of the factory stays dependency-light.
"""

from __future__ import annotations

import contextlib
import re
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .worktree import Worktree, git, sanitize_gitlink

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


# ------------------------------------------------------------------ git in the box

#: Where the box sees the host's object store (read-only) and its own scratch repo.
_BASE_OBJECTS = "/base/objects"
_SCRATCH_GIT = "/scratch/git"
_OUT = "/out"
#: The ref the box exports its final HEAD under, and where the host receives it.
_EXPORT_REF = "refs/warden/export"
_INCOMING_REF = "refs/warden/incoming"

# Runs as the container's entrypoint, then execs nothing: it stays the parent so
# it can export the agent's commits once the agent exits. The scratch repo starts
# at WARDEN_START on WARDEN_BRANCH with an index matching the checked-out tree,
# so `git status/diff/commit/log` behave exactly as in the host worktree.
_BOX_SCRIPT = f"""\
set -e
export GIT_DIR={_SCRATCH_GIT} GIT_WORK_TREE=/workspace \
GIT_ALTERNATE_OBJECT_DIRECTORIES={_BASE_OBJECTS}
git init -q
git update-ref "refs/heads/$WARDEN_BRANCH" "$WARDEN_START"
git symbolic-ref HEAD "refs/heads/$WARDEN_BRANCH"
git read-tree HEAD
git update-index -q --refresh >/dev/null 2>&1 || true
set +e
"$@"
rc=$?
if [ -d {_OUT} ]; then
  head=$(git rev-parse -q --verify HEAD)
  printf '%s\\n' "$head" > {_OUT}/head.txt
  if [ -n "$head" ] && [ "$head" != "$WARDEN_START" ]; then
    git update-ref {_EXPORT_REF} "$head"
    git bundle create -q {_OUT}/result.bundle {_EXPORT_REF} "^$WARDEN_START" \
      >/dev/null 2>&1 || true
  fi
fi
exit $rc
"""


class BoxImportError(SandboxError):
    """The box's commits could not be brought back to the host repository."""


@dataclass(frozen=True)
class Box:
    """One container's view of a worktree.

    ``objects`` is the host repository's object store (mounted read-only) and
    ``start`` the commit the box's scratch repository begins at; without them
    the box has no git at all. ``out_dir`` (agent boxes only) receives the
    exported commits; ``name`` is what a kill targets.
    """

    name: str
    worktree: Path
    objects: Path | None = None
    start: str = ""
    branch: str = ""
    out_dir: Path | None = None


_NAME_UNSAFE = re.compile(r"[^a-zA-Z0-9_.-]+")


def container_name(*parts: str) -> str:
    """A unique, Docker-valid container name: `warden-<parts>-<nonce>`."""
    stem = "-".join(_NAME_UNSAFE.sub("-", p).strip("-") for p in parts if p)
    return f"warden-{stem}-{secrets.token_hex(3)}"[:120]


def box_for(wt: Worktree, *, tag: str, out_dir: Path | None = None) -> Box:
    """A Box for one phase (agent / setup / verify) of a task's worktree.

    The worktree's `.git` pointer is restored first: the host is about to run
    git in a tree the previous box could write to.
    """
    sanitize_gitlink(wt)
    common = git(wt.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    start = git(wt.path, "rev-parse", "HEAD").stdout.strip()
    return Box(
        name=container_name(wt.path.parent.parent.name, wt.path.name, tag),
        worktree=wt.path,
        objects=Path(common.stdout.strip()) / "objects",
        start=start,
        branch=wt.branch,
        out_dir=out_dir,
    )


def kill_container(name: str) -> None:
    """Stop a box for good. Best-effort and silent: it runs on timeout/cancel paths,
    and a container that already exited is exactly the outcome we want."""
    with contextlib.suppress(SandboxError, OSError, subprocess.SubprocessError):
        _run(["kill", name], timeout=30.0)
        _run(["rm", "-f", name], timeout=30.0)


def _box_args(box: Box) -> list[str]:
    """Docker args for the box's filesystem view: the worktree, git (scratch repo
    over a read-only object store), the export dir, the hooks script, identity."""
    args = ["--name", box.name, "-v", f"{_docker_path(box.worktree)}:/workspace",
            "-w", "/workspace"]
    if box.objects is not None:
        args += [
            "-v", f"{_docker_path(box.objects)}:{_BASE_OBJECTS}:ro",
            "--tmpfs", "/scratch",
            "-e", f"WARDEN_START={box.start}",
            "-e", f"WARDEN_BRANCH={box.branch or 'warden'}",
        ]
    if box.out_dir is not None:
        box.out_dir.mkdir(parents=True, exist_ok=True)
        for stale in ("head.txt", "result.bundle"):
            (box.out_dir / stale).unlink(missing_ok=True)
        args += ["-v", f"{_docker_path(box.out_dir)}:{_OUT}"]
    args += ["-v", f"{_docker_path(_hooks_script())}:{_sandbox_hooks_target()}:ro"]
    gitconfig = Path.home() / ".gitconfig"
    if gitconfig.is_file():
        # Commits carry the operator's identity, as in a direct run.
        args += ["-v", f"{_docker_path(gitconfig)}:/root/.gitconfig:ro"]
    # Additive (does not replace the mounted .gitconfig): trust the bind mount.
    args += ["-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory",
             "-e", "GIT_CONFIG_VALUE_0=*"]
    return args


def _entry(box: Box) -> list[str]:
    """The command prefix inside the box: the git bootstrap when it has git."""
    return ["bash", "-c", _BOX_SCRIPT, "warden"] if box.objects is not None else []


def _hooks_script() -> Path:
    from .agent import HOOKS_SCRIPT  # agent imports this module; resolve lazily
    return HOOKS_SCRIPT


def _sandbox_hooks_target() -> str:
    from .agent import SANDBOX_HOOKS_SCRIPT
    return SANDBOX_HOOKS_SCRIPT


# The CLI's own background traffic (telemetry, error reports, update checks) is
# not needed to do the work, and the egress allow-list no longer admits it.
_QUIET_CLI_ENV = (
    "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e", "DISABLE_TELEMETRY=1",
    "-e", "DISABLE_ERROR_REPORTING=1",
    "-e", "DISABLE_AUTOUPDATER=1",
)


# ------------------------------------------------------------------ wrap

def wrap(base_cmd: list[str], worktree_path: Path, box: Box | None = None) -> list[str]:
    """Turn the host `claude -p …` argv into a hardened `docker run … claude -p …`.

    base_cmd[0] is the host-resolved claude executable (dropped — the container has
    its own `claude` on PATH); base_cmd[1:] are the CLI flags, which are all
    container-agnostic. A host-only `--mcp-config <path>` (ragmcp knowledge base)
    is stripped: that server lives on the host and isn't reachable from the box —
    knowledge-base + sandbox is a documented follow-up, not a silent broken run.
    Without a ``box`` (no git context) the container still runs, just git-less.
    """
    box = box or Box(name=container_name(worktree_path.name, "agent"), worktree=worktree_path)
    args = _strip_host_only_flags(base_cmd[1:])
    creds = _docker_path(credentials_path())
    proxy = f"http://{PROXY_NAME}:{PROXY_PORT}"
    return [
        _docker(), "run", "--rm", "-i",
        # egress: internal net only, forced through the allow-list proxy
        "--network", NET_INTERNAL,
        "-e", f"HTTP_PROXY={proxy}", "-e", f"HTTPS_PROXY={proxy}",
        "-e", f"http_proxy={proxy}", "-e", f"https_proxy={proxy}",
        *_QUIET_CLI_ENV,
        # privilege + resource hardening
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", PIDS_LIMIT,
        "--memory", MEM_LIMIT,
        "--cpus", CPU_LIMIT,
        # the worktree + scratch git; auth token mounted read-only
        *_box_args(box),
        "-v", f"{creds}:{CREDS_TARGET}:ro",
        AGENT_IMAGE,
        *_entry(box),
        "claude", *args,
    ]


def import_result(wt: Worktree, box: Box) -> None:
    """Bring the agent's commits back from the box into the host repository.

    The box exported its final HEAD (head.txt) and, when it made new commits, a
    bundle holding them. Fetching from a bundle reads pack data only — it never
    executes anything the agent wrote. The task branch is then pointed at that
    HEAD and the worktree's index reset to it, leaving the agent's working-tree
    files (including any uncommitted edits) exactly as the agent left them.

    No head.txt means the box never reached its export step (killed, crashed):
    the branch stays where it was, which is the honest state.
    """
    if box.out_dir is None:
        return
    head_file = box.out_dir / "head.txt"
    if not head_file.exists():
        return
    head = head_file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", head):
        raise BoxImportError(f"the box exported an unreadable HEAD: {head[:80]!r}")
    if head == box.start:
        return
    bundle = box.out_dir / "result.bundle"
    incoming = f"{_INCOMING_REF}/{_NAME_UNSAFE.sub('-', wt.branch)}"
    known = git(wt.repo, "cat-file", "-e", f"{head}^{{commit}}", check=False).returncode == 0
    if not known:
        if not bundle.exists():
            raise BoxImportError("the box made commits but exported no bundle")
        git(wt.repo, "fetch", "--no-tags", "--no-write-fetch-head", str(bundle),
            f"+{_EXPORT_REF}:{incoming}")
    try:
        git(wt.repo, "update-ref", f"refs/heads/{wt.branch}", head)
    finally:
        git(wt.repo, "update-ref", "-d", incoming, check=False)
    sanitize_gitlink(wt)
    git(wt.path, "read-tree", "HEAD")


def run_command(
    cmd: str, worktree_path: Path, *, allow_network: bool, timeout_s: int,
    box: Box | None = None,
) -> tuple[int, str]:
    """Run ONE shell command inside the hardened box against the worktree, and
    return (returncode, combined output). Raises subprocess.TimeoutExpired on
    timeout so callers handle it uniformly with the host path — after killing
    the container, which a client-side timeout alone would leave running.

    Used for the setup and verify phases (NOT the agent). No auth token is mounted
    here — these phases never talk to Anthropic — so a malicious dependency or an
    agent-authored test can't read the subscription token. `allow_network` gates
    egress: True (bridge) for setup, since dependency installs (uv/npm) need pypi/
    npm and the commands are trusted operator config; False (--network none) for
    verify, since it runs the agent's own test code — offline, it cannot exfiltrate.
    """
    box = box or Box(name=container_name(worktree_path.name, "cmd"), worktree=worktree_path)
    net = ["--network", "bridge"] if allow_network else ["--network", "none"]
    proc = subprocess.Popen(
        [
            _docker(), "run", "--rm",
            *net,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", PIDS_LIMIT, "--memory", MEM_LIMIT, "--cpus", CPU_LIMIT,
            *_box_args(box),
            AGENT_IMAGE, *_entry(box), "bash", "-c", cmd,
        ],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    try:
        out, _ = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        kill_container(box.name)
        proc.kill()
        proc.communicate()
        raise
    return proc.returncode, out or ""


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
        # --strict-mcp-config stays: it holds no host path, and it keeps the box
        # from loading any MCP server beyond what Warden hands it.
        out.append(a)
    return out
