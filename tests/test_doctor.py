"""Capability check: real permission probe before spending a run."""

from __future__ import annotations

import asyncio

from factory.doctor import format_report, run_doctor
from test_e2e import make_config


def test_doctor_reports_denials(tmp_path):
    report = asyncio.run(run_doctor(make_config(), tmp_path, tmp_path / "doc.jsonl"))
    assert report.internet == "denied"
    assert report.commands[0]["result"] == "ok"

    text = format_report(report)
    assert "Internet access" in text and "[DENIED]" in text
    assert "git --version" in text and "[OK]" in text
    assert "fix Settings before starting a run" in text


def test_format_report_all_green():
    from factory.doctor import DoctorReport

    text = format_report(DoctorReport(
        internet="ok",
        commands=[{"cmd": "npm install", "result": "ok"}],
        notes="",
    ))
    assert "All configured capabilities verified." in text
    assert "DENIED" not in text
