"""LangGraph state contract.

Only ``prompt`` and ``session_id`` are required at invocation time. Callers may
also provide user and project scope. Each graph node returns a partial mapping;
the compiled graph merges those mappings into the working state.
"""

from typing import NotRequired, Required, TypedDict

from contracts import (
    BlockHit,
    CandidateRewrite,
    CostBand,
    PredictionContext,
    RetrievedExample,
    Route,
    ScoredRewrite,
    UserProfile,
)


class AgentState(TypedDict):
    prompt: Required[str]
    session_id: Required[str]
    user_id: NotRequired[str]
    project: NotRequired[str | None]
    force_suggestions: NotRequired[bool]
    ctx: NotRequired[PredictionContext]
    profile: NotRequired[UserProfile]
    block_hits: NotRequired[list[BlockHit]]
    predicted_cost: NotRequired[CostBand | None]
    retrieved_examples: NotRequired[list[RetrievedExample]]
    allowed_types: NotRequired[list[str]]
    candidate_rewrites: NotRequired[list[CandidateRewrite]]
    scored_rewrites: NotRequired[list[ScoredRewrite]]
    suggestions: NotRequired[list[ScoredRewrite]]
    expected_upside: NotRequired[float]
    reason_model: NotRequired[str | None]
    route: NotRequired[Route]
