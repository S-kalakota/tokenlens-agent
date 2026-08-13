"""Feature-space contract shared by gate and rescore.

The order and buckets are intentionally explicit. Agent A may implement the
feature calculations, but both prediction entry points must consume this one
ordered schema.
"""

from typing import TypeAlias

from contracts import PredictionContext


FeatureValue: TypeAlias = float | int | str | None
FeatureRow: TypeAlias = dict[str, FeatureValue]

PROMPT_DERIVED_FEATURES: tuple[str, ...] = (
    "prompt_token_estimate",
    "line_count",
    "fenced_block_count",
    "duplicate_line_ratio",
    "repeated_block_token_share",
    "path_token_count",
    "whitespace_ratio",
)

CONTEXT_DERIVED_FEATURES: tuple[str, ...] = (
    "target_model",
    "project",
    "session_turn_index",
    "recent_cost_last",
    "recent_cost_mean",
    "recent_cost_p50",
)

# These values are unavailable before execution and must never be omitted.
POST_EXECUTION_ONLY_FEATURES: tuple[str, ...] = ("completion_ratio",)

POST_EXECUTION_IMPUTATION_SOURCES: dict[str, str] = {
    "completion_ratio": "completion_ratio_median",
}

FEATURE_ORDER: tuple[str, ...] = (
    *PROMPT_DERIVED_FEATURES,
    *CONTEXT_DERIVED_FEATURES,
    *POST_EXECUTION_ONLY_FEATURES,
)


def validate_feature_contract() -> None:
    """Raise if a feature appears in multiple buckets or lacks imputation."""

    buckets = (
        PROMPT_DERIVED_FEATURES,
        CONTEXT_DERIVED_FEATURES,
        POST_EXECUTION_ONLY_FEATURES,
    )
    flattened = [feature for bucket in buckets for feature in bucket]
    if len(flattened) != len(set(flattened)):
        raise RuntimeError("Feature buckets must be disjoint")
    missing_imputations = set(POST_EXECUTION_ONLY_FEATURES).difference(
        POST_EXECUTION_IMPUTATION_SOURCES
    )
    if missing_imputations:
        raise RuntimeError(
            "Post-execution features lack context imputations: "
            f"{sorted(missing_imputations)}"
        )


def build_feature_row(prompt: str, ctx: PredictionContext) -> FeatureRow:
    """Build one model row.

    Feature extraction belongs to Part 3 (Agent A). The contract lives here so
    gate and rescore cannot independently invent feature vectors.
    """

    del prompt, ctx
    raise NotImplementedError("Real featurization starts in Part 3 (Agent A)")


validate_feature_contract()
