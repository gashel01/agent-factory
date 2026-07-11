"""Capability check: prove the configured permissions before spending a run.

`factory doctor` spawns ONE minimal agent with the workspace's exact
agent.allowed_tools and asks it to actually try (1) fetching a web page and
(2) the configured setup commands. Permission denials are observed for real —
the same mechanism that silently blocks agents mid-run — at the cost of a
single tiny agent call instead of a wasted run.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from .agent import extract_trailing_json, is_rate_limit_result, stream_headless
from .config import Config

DOCTOR_CONTRACT = """\
# Capability check — Agent Factory

You are verifying this factory's agent permissions. Perform EXACTLY these
probes, one tool call each, and nothing else. A denied tool call is a normal,
expected outcome — record it and move on, never retry or work around it.

1. INTERNET: fetch https://example.com with WebFetch (or, if unavailable,
   run one WebSearch for "example domain"). Record: "ok" if content came
   back, "denied" if the tool was refused or unavailable.
2. COMMANDS: run each command below with Bash, exactly as written, in the
   current directory. Record per command: "ok" (exit 0), "exit <N>"
   (ran but failed — that still proves permission), or "denied".

Commands to probe:
{probes}

End your final message with strict JSON (no fences):
{{"status": "done", "internet": "ok"|"denied",
  "commands": [{{"cmd": "...", "result": "ok"|"denied"|"exit <N>"}}],
  "notes": "<one short line, only if something surprised you>"}}
"""


class DoctorError(Exception):
    """Probe infrastructure failed (not a capability verdict)."""


@dataclass(frozen=True)
class DoctorReport:
    internet: str
    commands: list[dict]
    notes: str


async def run_doctor(cfg: Config, workdir: Path, log_path: Path) -> DoctorReport:
    exe = shutil.which(cfg.agent.command[0])
    if exe is None:
        raise DoctorError(f"agent command '{cfg.agent.command[0]}' not found on PATH")

    probes = ["git --version", *cfg.setup.commands]
    prompt = DOCTOR_CONTRACT.format(probes="\n".join(f"- {c}" for c in probes))

    cmd = [
        exe,
        *cfg.agent.command[1:],
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "15",
        "--allowedTools",
        ",".join(cfg.agent.allowed_tools),  # the EXACT permissions runs will get
    ]
    if cfg.agent.model:
        cmd += ["--model", cfg.agent.model]

    try:
        out = await stream_headless(cmd, prompt, workdir, log_path, timeout_s=5 * 60)
    except TimeoutError as exc:
        raise DoctorError("capability check exceeded 5 minutes") from exc

    if out.stderr_rate_limited or (out.result is not None and is_rate_limit_result(out.result)):
        raise DoctorError("usage limit hit — try again when your window resets")
    if out.returncode != 0 or out.result is None:
        raise DoctorError(out.stderr_tail or f"probe agent exited {out.returncode}")

    verdict = extract_trailing_json(str(out.result.get("result", "")))
    if verdict is None:
        raise DoctorError("probe agent returned no parseable verdict")
    return DoctorReport(
        internet=str(verdict.get("internet", "unknown")),
        commands=[c for c in verdict.get("commands", []) if isinstance(c, dict)],
        notes=str(verdict.get("notes", "")),
    )


def format_report(report: DoctorReport) -> str:
    mark = {"ok": "[OK]", "denied": "[DENIED]"}
    lines = [f"Internet access   {mark.get(report.internet, report.internet)}"]
    for probe in report.commands:
        result = str(probe.get("result", "?"))
        label = mark.get(result, f"[{result.upper()}]")
        lines.append(f"{str(probe.get('cmd', '?')):<18}{label}")
    if report.notes:
        lines.append(f"note: {report.notes}")
    denied = report.internet == "denied" or any(
        p.get("result") == "denied" for p in report.commands
    )
    lines.append(
        "Some capabilities are DENIED — fix Settings before starting a run."
        if denied
        else "All configured capabilities verified."
    )
    return "\n".join(lines)
