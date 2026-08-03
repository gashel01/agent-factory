"""External webhook notifications: config parsing + best-effort delivery."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from factory.config import NotifyConfig, load_config
from factory.notify import post_webhook


def test_notify_config_parses(tmp_path: Path) -> None:
    cfg = tmp_path / "factory.yaml"
    cfg.write_text('notify:\n  webhook: "https://example.com/hook"\n', encoding="utf-8")
    assert load_config(cfg).notify == NotifyConfig(webhook_url="https://example.com/hook")
    # Absent → empty, delivery is a no-op.
    assert load_config(None).notify.webhook_url == ""


def test_post_webhook_no_url() -> None:
    assert post_webhook("", "hello") is False


def test_post_webhook_delivers_payload() -> None:
    received: dict[str, object] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            received.update(json.loads(self.rfile.read(length)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:  # silence test output
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    host, port = server.server_address
    ok = post_webhook(f"http://{host}:{port}/hook", "Run finished — 3 merged.")
    thread.join(timeout=5)
    server.server_close()

    assert ok is True
    # Both keys are sent so Slack (text) and Discord (content) both render.
    assert received["text"] == "Run finished — 3 merged."
    assert received["content"] == "Run finished — 3 merged."


def test_post_webhook_unreachable_is_false() -> None:
    # Port 0 is not connectable — must fail closed, never raise.
    assert post_webhook("http://127.0.0.1:1/hook", "x") is False
