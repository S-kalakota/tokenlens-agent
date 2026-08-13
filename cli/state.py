"""Pure state transitions for the two-Enter pre-send contract.

This module deliberately has no I/O.  The terminal UI and integration tests use
the same transitions, making the permission to launch Claude an inspectable
value rather than an implicit side effect of keyboard handling.
"""

import hashlib
import uuid
from typing import Literal, NotRequired, TypedDict, cast

from contracts import AnalysisEvent, CostBand, ScoredRewrite

ComposerPhase = Literal["draft", "analyzing", "review", "ready", "sending"]
ComposerDecision = Literal["accepted", "skipped"]


class ComposerState(TypedDict):
    phase: ComposerPhase
    draft_text: str
    draft_version: int
    analysis_id: str | None
    analyzed_prompt_hash: str | None
    original_prompt: str | None
    original_cost: CostBand | None
    suggestions: list[ScoredRewrite]
    decision: ComposerDecision | None
    selected_prompt: str | None
    selected_prompt_hash: str | None
    claude_session_id: str | None
    send_attempt_id: str | None
    last_error: NotRequired[str | None]


class ComposerTransitionError(RuntimeError):
    """Raised when a caller attempts a forbidden state transition."""


def prompt_hash(prompt: str) -> str:
    """Hash the exact UTF-8 bytes displayed in the editable buffer."""

    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def new_composer_state(
    *,
    claude_session_id: str | None = None,
    draft_version: int = 0,
) -> ComposerState:
    return {
        "phase": "draft",
        "draft_text": "",
        "draft_version": draft_version,
        "analysis_id": None,
        "analyzed_prompt_hash": None,
        "original_prompt": None,
        "original_cost": None,
        "suggestions": [],
        "decision": None,
        "selected_prompt": None,
        "selected_prompt_hash": None,
        "claude_session_id": claude_session_id,
        "send_attempt_id": None,
        "last_error": None,
    }


def _invalidated_draft(
    state: ComposerState,
    text: str,
    *,
    error: str | None = None,
) -> ComposerState:
    next_state = new_composer_state(
        claude_session_id=state["claude_session_id"],
        draft_version=state["draft_version"] + 1,
    )
    next_state["draft_text"] = text
    next_state["last_error"] = error
    return next_state


def edit_draft(state: ComposerState, text: str) -> ComposerState:
    """Apply an edit and synchronously revoke any analysis/send permission."""

    if state["phase"] == "sending":
        raise ComposerTransitionError("cannot edit while Claude is sending")
    if text == state["draft_text"] and state["phase"] == "draft":
        return dict(state)  # type: ignore[return-value]
    return _invalidated_draft(state, text)


def begin_analysis(
    state: ComposerState,
    *,
    analysis_id: str | None = None,
) -> ComposerState:
    """Freeze the first-Enter snapshot without granting send permission."""

    if state["phase"] != "draft":
        raise ComposerTransitionError("analysis can start only from draft")
    if not state["draft_text"].strip():
        raise ComposerTransitionError("prompt must be non-empty")

    snapshot = state["draft_text"]
    next_state: ComposerState = {
        **state,
        "phase": "analyzing",
        "draft_version": state["draft_version"] + 1,
        "analysis_id": analysis_id or str(uuid.uuid4()),
        "analyzed_prompt_hash": prompt_hash(snapshot),
        "original_prompt": snapshot,
        "original_cost": None,
        "suggestions": [],
        "decision": None,
        "selected_prompt": None,
        "selected_prompt_hash": None,
        "send_attempt_id": None,
        "last_error": None,
    }
    return next_state


def event_matches(state: ComposerState, event: AnalysisEvent) -> bool:
    """Return whether an async event belongs to the live frozen draft."""

    return (
        state["phase"] == "analyzing"
        and event["analysis_id"] == state["analysis_id"]
        and event["draft_version"] == state["draft_version"]
        and event["prompt_hash"] == state["analyzed_prompt_hash"]
        and state["original_prompt"] is not None
        and prompt_hash(state["original_prompt"]) == event["prompt_hash"]
    )


def apply_analysis_event(
    state: ComposerState,
    event: AnalysisEvent,
) -> ComposerState:
    """Apply a current event or silently discard a stale one."""

    if not event_matches(state, event):
        return dict(state)  # type: ignore[return-value]

    if event["event"] == "cost_ready":
        return cast(ComposerState, {**state, "original_cost": event["cost"]})
    if event["event"] == "suggestions_ready":
        return cast(
            ComposerState,
            {
                **state,
                "phase": "review",
                "suggestions": list(event["suggestions"]),
            },
        )
    return _invalidated_draft(
        state,
        state["original_prompt"] or state["draft_text"],
        error=event["error"],
    )


def accept_suggestion(state: ComposerState, index: int) -> ComposerState:
    """Freeze one displayed rewrite and enter ``ready``."""

    if state["phase"] != "review":
        raise ComposerTransitionError("suggestions can be accepted only in review")
    if not 0 <= index < len(state["suggestions"]):
        raise ComposerTransitionError("suggestion index is out of range")
    selected = state["suggestions"][index]["rewrite"]
    return cast(
        ComposerState,
        {
            **state,
            "phase": "ready",
            "draft_text": selected,
            "decision": "accepted",
            "selected_prompt": selected,
            "selected_prompt_hash": prompt_hash(selected),
            "last_error": None,
        },
    )


def skip_optimization(state: ComposerState) -> ComposerState:
    """Explicitly select the original analyzed prompt and enter ``ready``."""

    if state["phase"] != "review":
        raise ComposerTransitionError("optimization can be skipped only in review")
    original = state["original_prompt"]
    if original is None:
        raise ComposerTransitionError("review state has no original prompt")
    return cast(
        ComposerState,
        {
            **state,
            "phase": "ready",
            "draft_text": original,
            "decision": "skipped",
            "selected_prompt": original,
            "selected_prompt_hash": prompt_hash(original),
            "last_error": None,
        },
    )


def prepare_send(
    state: ComposerState,
    *,
    send_attempt_id: str | None = None,
) -> ComposerState:
    """Revalidate every frozen hash immediately before crossing the boundary."""

    if state["phase"] != "ready":
        raise ComposerTransitionError("Claude can be launched only from ready")
    if state["decision"] not in ("accepted", "skipped"):
        raise ComposerTransitionError("an explicit Accept or Skip is required")
    if state["original_prompt"] is None or state["analyzed_prompt_hash"] is None:
        raise ComposerTransitionError("analysis snapshot is missing")
    if prompt_hash(state["original_prompt"]) != state["analyzed_prompt_hash"]:
        raise ComposerTransitionError("analysis snapshot hash no longer matches")
    selected = state["selected_prompt"]
    selected_hash = state["selected_prompt_hash"]
    if selected is None or selected_hash is None:
        raise ComposerTransitionError("selected prompt is missing")
    visible_hash = prompt_hash(state["draft_text"])
    if state["draft_text"] != selected or visible_hash != selected_hash:
        raise ComposerTransitionError("visible prompt changed after selection")
    return cast(
        ComposerState,
        {
            **state,
            "phase": "sending",
            "send_attempt_id": send_attempt_id or str(uuid.uuid4()),
            "last_error": None,
        },
    )


def send_failed(state: ComposerState, error: str) -> ComposerState:
    """Return to ready; retries always require another explicit Enter."""

    if state["phase"] != "sending":
        raise ComposerTransitionError("only an active send can fail")
    return cast(
        ComposerState,
        {**state, "phase": "ready", "last_error": error},
    )


def send_succeeded(
    state: ComposerState,
    claude_session_id: str | None,
) -> ComposerState:
    """Open the next draft while preserving Claude's resumable session ID."""

    if state["phase"] != "sending":
        raise ComposerTransitionError("only an active send can succeed")
    return new_composer_state(
        claude_session_id=claude_session_id or state["claude_session_id"],
        draft_version=state["draft_version"] + 1,
    )
