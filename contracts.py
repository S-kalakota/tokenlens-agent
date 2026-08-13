"""Shared TokenLens contracts.

This module contains data shapes only. Keeping them independent of the model,
database, graph, and MCP implementations lets those layers be built in
parallel without importing one another's internals.
"""

from typing import Literal, NotRequired, TypedDict

Route = Literal["full", "deterministic", "skip"]
BlockKind = Literal["fenced_code", "line_window"]
DraftDecision = Literal["accepted", "skipped", "edited", "failed"]

SUGGESTION_TYPES: tuple[str, ...] = (
    "dedupe",
    "trim_boilerplate",
    "collapse_block",
    "remove_redundant_context",
    "summarize_context",
)


class CostBand(TypedDict):
    """Quantile prediction for the token cost of a prompt."""

    p10: float
    p50: float
    p90: float


class PredictionContext(TypedDict):
    """Context held fixed between the gate and rescore predictions."""

    user_id: str
    session_id: str
    project: str | None
    target_model: str
    session_turn_index: int
    recent_costs: list[float]
    completion_ratio_median: float
    calibration_bias: float


class CostQuantiles(TypedDict):
    p40: float
    p50: float
    p90: float
    n: int


class AcceptanceStats(TypedDict):
    """A shrunk acceptance rate and the raw counts behind it."""

    rate: float
    accepted: int
    total: int


class CalibrationStats(TypedDict):
    bias: float
    mae: float
    n: int


class ProjectProfile(TypedDict):
    cost_quantiles: CostQuantiles
    calibration: CalibrationStats
    completion_ratio_median: float


class UserProfile(TypedDict):
    """Derived memory used for decisions, not a raw Mongo document."""

    user_id: str
    cost_quantiles: CostQuantiles
    per_project: dict[str, ProjectProfile]
    accept_rate_by_type: dict[str, AcceptanceStats]
    calibration: CalibrationStats
    completion_ratio_median: float
    updated_at: str | None


class BlockFingerprint(TypedDict):
    block_hash: str
    kind: BlockKind
    normalized_text: str
    start_line: int
    end_line: int
    token_count: int


class BlockHit(BlockFingerprint):
    occurrences: int
    collapse_accepted: int


class RetrievedExample(TypedDict):
    prompt_excerpt: str
    rewrite: str
    rationale: str
    suggestion_type: str
    actual_savings: float
    similarity: float


class CandidateRewrite(TypedDict):
    rewrite: str
    rationale: str
    suggestion_type: str
    # Deterministic collapse candidates carry the exact recurring block(s)
    # they replace. LLM candidates normally omit this provenance.
    source_block_hashes: NotRequired[list[str]]


class ScoredRewrite(CandidateRewrite):
    suggestion_id: NotRequired[str]
    predicted_cost: CostBand
    estimated_savings: float
    acceptance_probability: NotRequired[float]
    expected_value: NotRequired[float]


class PackagedSuggestion(TypedDict):
    suggestion_id: NotRequired[str]
    rewrite: str
    estimated_savings: float
    rationale: str
    suggestion_type: str
    predicted_cost: NotRequired[CostBand]
    source_block_hashes: NotRequired[list[str]]


class OptimizePromptResponse(TypedDict):
    analysis_id: str
    prompt_hash: str
    suggestions: list[PackagedSuggestion]
    original_predicted_cost: CostBand


class RecordOutcomeResponse(TypedDict):
    ok: bool


class AnalyzeDraftRequest(TypedDict):
    """Immutable identity and context captured on the first Enter."""

    analysis_id: str
    draft_version: int
    prompt: str
    prompt_hash: str
    user_id: str
    project: str | None
    optimization_session_id: str
    force_suggestions: NotRequired[bool]


class CostReady(TypedDict):
    """The fast first event produced after the gate prediction."""

    event: Literal["cost_ready"]
    analysis_id: str
    draft_version: int
    prompt_hash: str
    cost: CostBand


class SuggestionsReady(TypedDict):
    """The terminal successful analysis event."""

    event: Literal["suggestions_ready"]
    analysis_id: str
    draft_version: int
    prompt_hash: str
    suggestions: list[ScoredRewrite]
    route: Route


class AnalysisFailed(TypedDict):
    """A terminal failure event that never grants permission to send."""

    event: Literal["analysis_failed"]
    analysis_id: str
    draft_version: int
    prompt_hash: str
    error: str


AnalysisEvent = CostReady | SuggestionsReady | AnalysisFailed
