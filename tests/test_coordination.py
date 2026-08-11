"""The coordination bus: the async seam that carries cross-cutting facts between
isolated agents (Levels 2-3). Pure, deterministic — no git, no agents."""

from __future__ import annotations

from factory.coordination import (
    CoordinationBus,
    extract_exports,
    whereis,
    world_index,
    world_view,
)


def test_extract_exports_reads_ts_export_forms():
    diff = (
        "diff --git a/dashboard/src/settings-modal.tsx b/dashboard/src/settings-modal.tsx\n"
        "--- a/dashboard/src/settings-modal.tsx\n"
        "+++ b/dashboard/src/settings-modal.tsx\n"
        "@@\n"
        "+export type DockerStatus = { running: boolean };\n"
        "+export function SettingsModal() { return null; }\n"
        "+const notExported = 1;\n"
        "+++ b/dashboard/src/story.tsx\n"
        "+export { StoryView, type UndoCtl as Ctl }\n"
    )
    got = extract_exports(diff)
    assert got["DockerStatus"] == "dashboard/src/settings-modal.tsx"
    assert got["SettingsModal"] == "dashboard/src/settings-modal.tsx"
    assert got["StoryView"] == "dashboard/src/story.tsx"
    assert got["Ctl"] == "dashboard/src/story.tsx"  # "as" alias is the exported name
    assert "notExported" not in got  # not exported → not tracked


def test_bus_append_and_read_roundtrip(tmp_path):
    bus = CoordinationBus(tmp_path / "coord.jsonl")
    assert bus.events() == []  # missing file is empty, not an error
    bus.claim("001", ["a.ts"])
    bus.decision("001", "naming", "modals live in *-modal.tsx")
    kinds = [e["kind"] for e in bus.events()]
    assert kinds == ["claim", "decision"]


def test_bus_tolerates_a_corrupt_line(tmp_path):
    path = tmp_path / "coord.jsonl"
    path.write_text('{"kind":"claim","ticket":"001","writes":[]}\nnot json\n', encoding="utf-8")
    assert [e["kind"] for e in CoordinationBus(path).events()] == ["claim"]


def test_world_view_surfaces_symbols_and_inflight_but_not_self():
    events = [
        {"kind": "claim", "ticket": "010", "writes": ["dashboard/src/log-modal.tsx"]},
        {"kind": "claim", "ticket": "011", "writes": ["dashboard/src/docs-modal.tsx"]},
        {"kind": "landed", "ticket": "009", "files": ["dashboard/src/settings-modal.tsx"],
         "symbols": {"DockerStatus": "dashboard/src/settings-modal.tsx"}},
    ]
    view = world_view(events, for_ticket="011")
    # The just-landed shared symbol is offered for import (the DockerStatus fix).
    assert "DockerStatus → dashboard/src/settings-modal.tsx" in view
    # A concurrent sibling's in-flight file is flagged...
    assert "log-modal.tsx (ticket 010)" in view
    # ...but the ticket's OWN claim is filtered out of its own snapshot.
    assert "docs-modal.tsx" not in view


def test_landed_claim_is_no_longer_in_flight():
    events = [
        {"kind": "claim", "ticket": "010", "writes": ["a.ts"]},
        {"kind": "landed", "ticket": "010", "files": ["a.ts"], "symbols": {}},
    ]
    assert world_index(events)["in_flight"] == {}


def test_decisions_dedupe_latest_wins_and_whereis():
    events = [
        {"kind": "decision", "ticket": "001", "key": "DockerStatus", "value": "settings.tsx"},
        {"kind": "decision", "ticket": "002", "key": "DockerStatus",
         "value": "settings.tsx (canonical)"},
        {"kind": "landed", "ticket": "003", "files": ["x.ts"],
         "symbols": {"RunProfile": "run-estimate-modal.tsx"}},
    ]
    assert whereis(events, "DockerStatus") == "settings.tsx (canonical)"
    assert whereis(events, "RunProfile") == "run-estimate-modal.tsx"
    assert whereis(events, "Nope") == ""


def test_world_view_empty_when_nothing_relevant():
    assert world_view([], for_ticket="001") == ""


def test_cmd_coord_posts_and_queries(tmp_path, monkeypatch, capsys):
    """The agent-facing `factory coord` CLI: post a decision, query it back. Ticket
    defaults from $FACTORY_TICKET_ID so the agent never has to pass it."""
    import argparse

    from factory.__main__ import cmd_coord

    monkeypatch.setenv("FACTORY_COORD_PATH", str(tmp_path / "coord.jsonl"))
    monkeypatch.setenv("FACTORY_TICKET_ID", "042")

    def ns(**over):
        base = dict(ticket="", whereis="", decision="", note="")
        base.update(over)
        return argparse.Namespace(**base)

    assert cmd_coord(ns(decision="DockerStatus=settings-modal.tsx")) == 0
    assert cmd_coord(ns(whereis="DockerStatus")) == 0
    assert "settings-modal.tsx" in capsys.readouterr().out

    events = CoordinationBus(tmp_path / "coord.jsonl").events()
    assert events[0]["ticket"] == "042"  # defaulted from the env
    assert events[0]["key"] == "DockerStatus"


def test_cmd_coord_without_bus_errors(monkeypatch):
    import argparse

    from factory.__main__ import cmd_coord

    monkeypatch.delenv("FACTORY_COORD_PATH", raising=False)
    ns = argparse.Namespace(ticket="", whereis="X", decision="", note="")
    assert cmd_coord(ns) == 1  # no active bus → non-zero, not a crash
