"""Host-neutral native view models; no terminal UI or ANSI rendering."""

from __future__ import annotations

from typing import Literal, TypedDict

from state import NativeComposerState


class NativeControl(TypedDict):
    id: str
    label: str
    enabled: bool


class NativeSuggestionView(TypedDict):
    index: int
    estimated_tokens: float
    estimated_savings: float
    rationale: str


class NativeView(TypedDict):
    kind: Literal["analyzing", "cost", "review", "ready", "error"]
    title: str
    message: str
    original_estimated_tokens: float | None
    suggestions: list[NativeSuggestionView]
    controls: list[NativeControl]


def render_state(state: NativeComposerState) -> NativeView:
    """Build structured content for a supported Claude Code UI adapter."""

    cost = state["original_cost"]
    estimate = float(cost["p50"]) if cost is not None else None
    if state.get("last_error"):
        return {
            "kind": "error",
            "title": "TokenLens could not complete this action",
            "message": str(state["last_error"]),
            "original_estimated_tokens": estimate,
            "suggestions": [],
            "controls": [],
        }
    if state["phase"] == "analyzing":
        return {
            "kind": "cost" if cost is not None else "analyzing",
            "title": "TokenLens prompt analysis",
            "message": (
                "Analyzing history and rewrites…"
                if cost is not None
                else "Estimating original prompt cost…"
            ),
            "original_estimated_tokens": estimate,
            "suggestions": [],
            "controls": [],
        }
    if state["phase"] == "review":
        suggestions = [
            {
                "index": index,
                "estimated_tokens": float(item["predicted_cost"]["p50"]),
                "estimated_savings": float(item["estimated_savings"]),
                "rationale": item["rationale"],
            }
            for index, item in enumerate(state["suggestions"], start=1)
        ]
        controls: list[NativeControl] = [
            {
                "id": str(item["index"]),
                "label": f"Accept {item['index']}",
                "enabled": True,
            }
            for item in suggestions
        ]
        controls.extend(
            (
                {"id": "s", "label": "Skip", "enabled": True},
                {"id": "e", "label": "Edit", "enabled": True},
            )
        )
        return {
            "kind": "review",
            "title": "Choose a TokenLens rewrite",
            "message": "Choose Accept or Skip; this does not send the prompt.",
            "original_estimated_tokens": estimate,
            "suggestions": suggestions,
            "controls": controls,
        }
    if state["phase"] == "ready":
        return {
            "kind": "ready",
            "title": "Prompt ready",
            "message": "Press Enter to send; editing restarts analysis.",
            "original_estimated_tokens": estimate,
            "suggestions": [],
            "controls": [],
        }
    return {
        "kind": "analyzing",
        "title": "TokenLens",
        "message": "",
        "original_estimated_tokens": estimate,
        "suggestions": [],
        "controls": [],
    }
