"""LangGraph state contract.

Only ``prompt`` and ``session_id`` exist at invocation time. Each graph node
must return a new partial mapping and must not overwrite a key produced by an
earlier node.
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
    ctx: NotRequired[PredictionContext]
    profile: NotRequired[UserProfile]
    block_hits: NotRequired[list[BlockHit]]
    predicted_cost: NotRequired[CostBand | None]
    retrieved_examples: NotRequired[list[RetrievedExample]]
    allowed_types: NotRequired[list[str]]
    candidate_rewrites: NotRequired[list[CandidateRewrite]]
    scored_rewrites: NotRequired[list[ScoredRewrite]]
    route: NotRequired[Route]
