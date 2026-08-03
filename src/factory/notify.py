"""External webhook notifications — Slack/Discord/generic.

Best-effort and fire-and-forget: a notification never blocks the run and never
raises into the dispatcher. The payload carries both ``text`` (Slack, generic)
and ``content`` (Discord) so a single URL works across the common receivers.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

_TIMEOUT_S = 8


def post_webhook(url: str, message: str) -> bool:
    """POST ``message`` to ``url``. Returns True on a 2xx, False on any failure.

    Errors are swallowed (logged by the caller if it cares): a flaky webhook must
    never fail a run.
    """
    if not url:
        return False
    payload = json.dumps({"text": message, "content": message}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False
