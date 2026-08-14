"""Pure native-composer transitions for the two-Enter safety contract."""

from __future__ import annotations

import hashlib
import uuid
from typing import Any, Literal, NotRequired, TypedDict, cast

ComposerPhase = Literal["draft", "analyzing", "review", "ready", "sending"]
ComposerDecision = Literal["accepted", "skipped"]


class CostBand(TypedDict):
    p10: float
    p50: float
    p90: float


class ScoredRewrite(TypedDict):
    rewrite: str
    rationale: str
    suggestion_type: str
    predicted_cost: CostBand
    estimated_savings: float


class NativeComposerState(TypedDict):
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
    claude_session_id: str
    send_attempt_id: str | None
    last_error: NotRequired[str | None]


class NativeTransitionError(RuntimeError):
    pass


def prompt_hash(prompt: str) -> str:
    """Hash exactly the UTF-8 bytes visible in the native composer."""

    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def new_state(claude_session_id: str) -> NativeComposerState:
    return {
        "phase": "draft",
        "draft_text": "",
        "draft_version": 0,
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


def _draft(
    state: NativeComposerState,
    text: str,
    *,
    error: str | None = None,
) -> NativeComposerState:
    next_state = new_state(state["claude_session_id"])
    next_state["draft_text"] = text
    next_state["draft_version"] = state["draft_version"] + 1
    next_state["last_error"] = error
    return next_state


def edit(state: NativeComposerState, text: str) -> NativeComposerState:
    """Synchronously revoke readiness when the live buffer changes."""

    if state["phase"] == "sending":
        raise NativeTransitionError("cannot edit while a prompt is releasing")
    if text == state["draft_text"]:
        return cast(NativeComposerState, dict(state))
    return _draft(state, text)


def begin_analysis(
    state: NativeComposerState,
    *,
    analysis_id: str | None = None,
) -> NativeComposerState:
    if state["phase"] != "draft":
        raise NativeTransitionError("analysis can start only from draft")
    if not state["draft_text"].strip():
        raise NativeTransitionError("prompt must be non-empty")
    snapshot = state["draft_text"]
    return cast(
        NativeComposerState,
        {
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
        },
    )


def event_matches(state: NativeComposerState, event: dict[str, Any]) -> bool:
    original = state["original_prompt"]
    return (
        state["phase"] == "analyzing"
        and event.get("analysis_id") == state["analysis_id"]
        and event.get("draft_version") == state["draft_version"]
        and event.get("prompt_hash") == state["analyzed_prompt_hash"]
        and original is not None
        and prompt_hash(original) == event.get("prompt_hash")
    )


def apply_event(
    state: NativeComposerState,
    event: dict[str, Any],
) -> NativeComposerState:
    """Apply current events and discard stale asynchronous results."""

    if not event_matches(state, event):
        return cast(NativeComposerState, dict(state))
    if event.get("event") == "cost_ready":
        return cast(NativeComposerState, {**state, "original_cost": event["cost"]})
    if event.get("event") == "suggestions_ready":
        return cast(
            NativeComposerState,
            {
                **state,
                "phase": "review",
                "suggestions": list(event.get("suggestions", []))[:3],
            },
        )
    if event.get("event") == "analysis_failed":
        return _draft(
            state,
            state["original_prompt"] or state["draft_text"],
            error=str(event.get("error") or "analysis failed"),
        )
    raise NativeTransitionError("unknown analysis event")


def accept(state: NativeComposerState, index: int) -> NativeComposerState:
    if state["phase"] != "review":
        raise NativeTransitionError("a suggestion can be accepted only in review")
    if not 0 <= index < len(state["suggestions"]):
        raise NativeTransitionError("suggestion index is out of range")
    selected = state["suggestions"][index]["rewrite"]
    return cast(
        NativeComposerState,
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


def skip(state: NativeComposerState) -> NativeComposerState:
    if state["phase"] != "review":
        raise NativeTransitionError("optimization can be skipped only in review")
    original = state["original_prompt"]
    if original is None:
        raise NativeTransitionError("review state has no original prompt")
    return cast(
        NativeComposerState,
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
    state: NativeComposerState,
    live_composer_text: str,
    *,
    send_attempt_id: str | None = None,
) -> NativeComposerState:
    """Re-read and validate the native buffer immediately before release."""

    if state["phase"] != "ready":
        raise NativeTransitionError("release is allowed only from ready")
    if state["decision"] not in ("accepted", "skipped"):
        raise NativeTransitionError("Accept or Skip is required before release")
    original = state["original_prompt"]
    analyzed_hash = state["analyzed_prompt_hash"]
    if original is None or prompt_hash(original) != analyzed_hash:
        raise NativeTransitionError("the analysis snapshot is invalid")
    selected = state["selected_prompt"]
    selected_hash = state["selected_prompt_hash"]
    if selected is None or selected_hash is None:
        raise NativeTransitionError("the selected prompt is missing")
    live_hash = prompt_hash(live_composer_text)
    if live_composer_text != selected or live_hash != selected_hash:
        raise NativeTransitionError("the native composer changed after selection")
    return cast(
        NativeComposerState,
        {
            **state,
            "phase": "sending",
            "draft_text": live_composer_text,
            "send_attempt_id": send_attempt_id or str(uuid.uuid4()),
            "last_error": None,
        },
    )


def send_failed(state: NativeComposerState, error: str) -> NativeComposerState:
    if state["phase"] != "sending":
        raise NativeTransitionError("only a sending prompt can fail")
    return cast(
        NativeComposerState,
        {**state, "phase": "ready", "last_error": error},
    )


def send_succeeded(state: NativeComposerState) -> NativeComposerState:
    if state["phase"] != "sending":
        raise NativeTransitionError("only a sending prompt can succeed")
    next_state = new_state(state["claude_session_id"])
    next_state["draft_version"] = state["draft_version"] + 1
    return next_state
