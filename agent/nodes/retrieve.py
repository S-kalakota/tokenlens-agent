"""Retrieve positive examples and constrain the reasoning action space."""

from typing import Any

from agent.state import AgentState
from contracts import SUGGESTION_TYPES
from db.repo import find_similar

MIN_ACCEPTANCE_RATE = 0.15
MIN_TYPE_OBSERVATIONS = 10


def _allowed_types(state: AgentState) -> list[str]:
    profile = state["profile"]
    stats_by_type = profile["accept_rate_by_type"]
    allowed = [
        suggestion_type
        for suggestion_type in SUGGESTION_TYPES
        if suggestion_type not in stats_by_type
        or stats_by_type[suggestion_type]["total"] < MIN_TYPE_OBSERVATIONS
        or stats_by_type[suggestion_type]["rate"] >= MIN_ACCEPTANCE_RATE
    ]
    # An overfit or corrupt profile must not make the reasoning model unable to
    # act. The full menu is the cold-start behavior specified by the contract.
    return allowed or list(SUGGESTION_TYPES)


def retrieve(state: AgentState) -> dict[str, Any]:
    """Retrieve accepted examples and determine allowed suggestion types."""

    ctx = state["ctx"]
    has_checkpointed_examples = "retrieved_examples" in state
    existing_examples = state.get("retrieved_examples", [])
    result: dict[str, Any] = {"allowed_types": _allowed_types(state)}
    if has_checkpointed_examples:
        # A MongoDBSaver checkpoint from the same editing session already paid
        # for this read. Preserve it rather than re-querying vector memory.
        result["retrieved_examples"] = existing_examples
        return result
    result["retrieved_examples"] = find_similar(
        state["prompt"],
        ctx["user_id"],
        k=3,
    )
    return result
