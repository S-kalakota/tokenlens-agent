"""Mongo document contracts for the episodic and derived memory tiers."""

from datetime import datetime
from typing import NotRequired, TypedDict

from contracts import (
    AcceptanceStats,
    BlockKind,
    CalibrationStats,
    CostBand,
    CostQuantiles,
    ProjectProfile,
)


class SessionDocument(TypedDict):
    _id: NotRequired[object]
    user_id: str
    session_id: str
    prompt_text: str
    predicted_cost: CostBand
    actual_cost: float | None
    project: str | None
    target_model: str
    turn_index: int
    block_hashes: list[str]
    timestamp: datetime


class PromptEmbeddingDocument(TypedDict):
    _id: NotRequired[object]
    session_document_id: object
    user_id: str
    prompt_text: str
    timestamp: datetime


class SuggestionDocument(TypedDict):
    _id: NotRequired[object]
    user_id: str
    session_id: str
    suggestion_type: str
    rewrite_text: str
    rationale: str
    predicted_savings: float
    accepted: bool | None
    actual_savings: float | None
    final_prompt: str | None
    source_block_hashes: list[str]
    timestamp: datetime


class UserProfileDocument(TypedDict):
    _id: str
    cost_quantiles: CostQuantiles
    per_project: dict[str, ProjectProfile]
    accept_rate_by_type: dict[str, AcceptanceStats]
    calibration: CalibrationStats
    completion_ratio_median: float
    updated_at: datetime


class BlockLibraryDocument(TypedDict):
    _id: NotRequired[object]
    user_id: str
    project: str | None
    block_hash: str
    kind: BlockKind
    normalized_text: str
    token_count: int
    occurrences: int
    collapse_accepted: int
    first_seen_at: datetime
    last_seen_at: datetime


# Checkpoint documents are owned by MongoDBSaver and must not be written by
# TokenLens repository code.
CHECKPOINT_SCHEMA_OWNER = "langgraph-checkpoint-mongodb"
