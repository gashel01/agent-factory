# Capsule — the project cockpit manifest

A **capsule** (`capsule.json`) is an agent-generated, human-frozen manifest that
describes how to build / run / verify / operate ONE project — and the controls
the dashboard renders for it. The dashboard understands only the *shape* (phases,
runners, palette surfaces); everything app-specific is **data**, never per-type
code. Non-determinism is confined to *generating* the capsule; once frozen,
execution is deterministic.

Lookup order: `<repo>/capsule.json` → `<repo>/.factory/capsule.json` → `<workdir>/capsule.json`.

## Schema

```jsonc
{
  "version": 1,
  "name": "…", "summary": "…",
  "runners": { "default": { "kind": "host" | "container", "image": "node:20" } },
  "doctor": [ { "id": "node", "label": "NODE", "probe": "node --version" } ],   // probe exits 0 → present
  "actions": [ {
    "id": "build", "label": "Build",
    "description": "one line: what it does / when to use it",
    "icon": "play" | "smartphone" | "external" | "eye",
    "primary": true,
    "steps": [ { "run": "npm run build", "cwd": "sub/dir", "on": "default", "retries": 1, "env": {} } ],
    "surface": "log-stream" | "device-install" | "preview" | "link",
    "service": true,               // long-running server: last step stays alive, URL captured, embedded preview + Stop
    "urlRegex": "…",               // optional: capture group 1 = served URL (default: first localhost URL)
    "artifact": "path/app.apk",    // device-install / download
    "url": "${lan}:5173",          // preview / link (${lan} → LAN base)
    "device": { "listCmd": "adb devices", "listRegex": "^(\\S+)\\s+device$", "installCmd": "adb -s ${device} install -r ${artifact}" },
    "consent": "install-x"         // requires this consent granted first
  } ],
  "panels": [ { "id": "loc", "title": "Lines of code", "source": "shell command; stdout is shown" } ],
  "consents": [ {
    "id": "install-x", "title": "…", "summary": "…",
    "facts": { "downloads": [{ "url": "…", "sha256": "…" }], "writes": ["dir"], "env": {}, "path": ["dir/bin"], "commands": ["verbatim"] },
    "steps": [ { "run": "…" } ],   // run on host AFTER the user approves the facts
    "granted": false
  } ]
}
```

## Runners
- **host** — the dev machine (GUI, physical device, games). Host steps inherit
  the process env + every granted consent's `env`/`path`.
- **container** — `docker run` with the repo mounted at `/work` (hermetic; only
  the step's declared `env` is passed via `-e`).

## Surfaces (the fixed palette the dashboard renders)
`log-stream` (default) · `device-install` (QR + download + adb install) ·
`preview` (open/embed a URL; with `service:true` = live embedded server + Stop) · `link`.

## The four agents (agent proposes, a deterministic gate / the human disposes)
- **Onboarding** — inspects a repo, generates the capsule. `/api/capsule/generate`.
- **Auto-provision** — a red doctor check → proposes install **consents** (raw
  facts) the user approves. `/api/capsule/provision`.
- **Ask AI to fix** — a failed action → an editing agent fixes the code, then the
  engine **re-verifies** the action's own commands. `/api/capsule/fix`.
- **Conversational edit** — plain-English instruction → rewrites the capsule as a
  reviewable **diff** (Apply/Discard). `/api/capsule/chat[/draft|/apply|/discard]`.

A host mutation (a consent's install steps) runs only after the user approves the
**raw facts** (urls, sha256, paths, env, commands) — never the agent's paraphrase.

## Auth
Mutating endpoints (POST/DELETE `/api/*`) require the per-install token from
`<workdir>/.dashboard-token`. Open the dashboard once with `?token=…` (printed at
startup). GETs are open, so viewing and the phone's APK download need no token.

## Runtime guard
A one-shot action whose command keeps running and prints a server/watcher signal
is killed after a grace period and flagged as a mislabeled service — so a bad
capsule never hangs; it says to set `service: true`.
