---
id: "001"   # quote ids: bare 001 is parsed as the integer 1 by YAML
title: Add input validation to the /users endpoint
repo: ../../myproject
files_hint: [src/api/users.py, tests/test_users.py]
depends_on: []
priority: 1
max_retries: 2
budget: { timeout_min: 30, max_turns: 50 }
verify:
  - pytest tests/test_users.py -q
---

## Context

POST /users currently accepts an empty `email` field and stores it as-is.
Validation lives in `src/api/users.py`; tests in `tests/test_users.py`.

## Success criteria (must be executable)

- `pytest tests/test_users.py -q` passes, including a NEW regression test that
  posts an empty email and expects a 422.

## Out of scope

- Do not touch other endpoints.
- Do not upgrade dependencies.
