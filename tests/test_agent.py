

def test_usage_counts_the_prompt_cache_both_ways() -> None:
    # Cache reads AND cache writes are real volume (and real cost): an agent
    # replays its context from the cache every turn.
    from factory.agent import _record_tokens, extract_usage
    rec = {"total_cost_usd": 0.23, "usage": {"input_tokens": 9, "output_tokens": 2700,
           "cache_read_input_tokens": 141000, "cache_creation_input_tokens": 19000}}
    u = extract_usage(rec)
    assert (u.cache_read_tokens, u.cache_write_tokens) == (141000, 19000)
    assert u.total_tokens == 162709
    assert _record_tokens({"message": {"usage": rec["usage"]}}) == 162709


def test_trailing_json_found_behind_many_nested_braces() -> None:
    # Regression (a real planner run on a small API spec): ticket bodies quoting API shapes put more
    # than 50 "{" inside the contract, and a scan capped at the last 50 never
    # reached the opening brace — the planner "returned no JSON".
    import json

    from factory.agent import extract_trailing_json
    body = 'Errors: `{ "error": { "code": "VALIDATION" } }`. ' * 40
    ticket = {"id": "001", "title": "t", "body": body}
    contract = {"status": "done", "brief": "b", "tickets": [ticket]}
    text = "I read SPEC.md.\n\n```json\n" + json.dumps(contract) + "\n```"
    got = extract_trailing_json(text)
    assert got is not None and got["tickets"][0]["body"] == body


def test_agents_report_in_the_tickets_language() -> None:
    # Seen live: English tickets, but the operator's Claude settings said French,
    # so every agent summary on the board came out in French.
    from factory.agent import DEFAULT_CONTRACT
    from factory.plan import PLANNER_CONTRACT
    from factory.review import REVIEW_CONTRACT
    assert "in the natural\n  language the ticket is written in" in DEFAULT_CONTRACT
    assert "commit messages" in DEFAULT_CONTRACT.split("LANGUAGE:")[1].split("\n- ")[0]
    assert "natural language the ticket is written in" in REVIEW_CONTRACT.replace("\n", " ")
    assert "your progress notes" in PLANNER_CONTRACT
