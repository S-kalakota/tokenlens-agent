import hashlib
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "claude-code"
sys.path.insert(0, str(PLUGIN_ROOT))

from state import (  # noqa: E402
    NativeTransitionError,
    accept,
    apply_event,
    begin_analysis,
    edit,
    new_state,
    prepare_send,
    prompt_hash,
    skip,
)


def suggestion(rewrite: str = "short prompt") -> dict:
    return {
        "rewrite": rewrite,
        "rationale": "Remove repetition",
        "suggestion_type": "dedupe",
        "predicted_cost": {"p10": 5.0, "p50": 10.0, "p90": 15.0},
        "estimated_savings": 90.0,
    }


def reviewing_state() -> dict:
    state = edit(new_state("claude-session"), "a long prompt")
    state = begin_analysis(state, analysis_id="analysis-1")
    return apply_event(
        state,
        {
            "event": "suggestions_ready",
            "analysis_id": "analysis-1",
            "draft_version": state["draft_version"],
            "prompt_hash": prompt_hash("a long prompt"),
            "suggestions": [suggestion()],
        },
    )


def test_prompt_hash_uses_exact_utf8_bytes() -> None:
    prompt = "café\n🙂"
    assert prompt_hash(prompt) == hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    assert prompt_hash(prompt) != prompt_hash(prompt + "\n")


def test_accept_and_skip_each_freeze_a_ready_prompt() -> None:
    review = reviewing_state()
    accepted = accept(review, 0)
    assert accepted["phase"] == "ready"
    assert accepted["draft_text"] == "short prompt"
    assert accepted["decision"] == "accepted"

    skipped = skip(review)
    assert skipped["phase"] == "ready"
    assert skipped["draft_text"] == "a long prompt"
    assert skipped["decision"] == "skipped"


def test_send_revalidates_live_composer_and_requires_ready() -> None:
    accepted = accept(reviewing_state(), 0)
    sending = prepare_send(
        accepted, "short prompt", send_attempt_id="attempt-1"
    )
    assert sending["phase"] == "sending"
    assert sending["send_attempt_id"] == "attempt-1"

    with pytest.raises(NativeTransitionError, match="changed after selection"):
        prepare_send(accepted, "short prompt edited")
    with pytest.raises(NativeTransitionError, match="only from ready"):
        prepare_send(reviewing_state(), "a long prompt")


def test_edit_invalidates_ready_and_stale_events_are_ignored() -> None:
    ready = accept(reviewing_state(), 0)
    edited = edit(ready, "short prompt with a change")
    assert edited["phase"] == "draft"
    assert edited["analysis_id"] is None
    assert edited["decision"] is None

    stale = apply_event(
        edited,
        {
            "event": "suggestions_ready",
            "analysis_id": "analysis-1",
            "draft_version": 2,
            "prompt_hash": prompt_hash("a long prompt"),
            "suggestions": [suggestion("stale")],
        },
    )
    assert stale == edited
