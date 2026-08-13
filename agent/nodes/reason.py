"""Reasoning-model contract and its Phase 0 fixture implementation."""

from copy import deepcopy
from typing import Any, Sequence, cast

from agent.state import AgentState
from config import load_stub_data, require_stub
from contracts import CandidateRewrite, RetrievedExample


def call_reasoning_model(
    prompt: str,
    retrieved_examples: Sequence[RetrievedExample],
    allowed_types: Sequence[str],
) -> list[CandidateRewrite]:
    """Return candidate rewrites from the configured reasoning model.

    Phase 0 deliberately provides only the fixture path. OpenRouter,
    validation, and retry behavior belong to Part 3 (Agent C).
    """

    require_stub("The reasoning-model call")
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")

    del retrieved_examples
    allowed = set(allowed_types)
    candidates = cast(
        list[CandidateRewrite],
        deepcopy(load_stub_data()["candidate_rewrites"]),
    )
    return [
        candidate
        for candidate in candidates
        if candidate["suggestion_type"] in allowed
    ][:3]


def reason(state: AgentState) -> dict[str, Any]:
    """Run the graph's reason node."""

    del state
    raise NotImplementedError("The reason node is implemented in Part 3 (Agent C)")
