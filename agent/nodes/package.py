"""Expected-value ranking and response truncation."""

from typing import Any

from agent.state import AgentState
from contracts import ScoredRewrite

MAX_SUGGESTIONS = 3


def _acceptance_probability(state: AgentState, suggestion_type: str) -> float:
    profile = state.get("profile")
    if profile is None:
        return 1.0
    stats = profile["accept_rate_by_type"].get(suggestion_type)
    # With no learned rate, expected-value ranking intentionally degrades to
    # raw predicted savings instead of inventing user preferences.
    return stats["rate"] if stats is not None else 1.0


def package(state: AgentState) -> dict[str, Any]:
    """Rank scored rewrites by expected value and return the top three."""

    # Checkpoint state can contain scored rewrites from a previous turn. A new
    # gate skip must never surface those stale candidates.
    if state.get("route") == "skip":
        return {"suggestions": []}

    ranked: list[ScoredRewrite] = []
    for rewrite in state.get("scored_rewrites", []):
        probability = _acceptance_probability(state, rewrite["suggestion_type"])
        ranked.append(
            {
                **rewrite,
                "acceptance_probability": probability,
                "expected_value": rewrite["estimated_savings"] * probability,
            }
        )
    ranked.sort(
        key=lambda item: (item["expected_value"], item["estimated_savings"]),
        reverse=True,
    )
    return {"suggestions": ranked[:MAX_SUGGESTIONS]}
