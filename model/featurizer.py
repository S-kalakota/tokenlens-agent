"""Feature extraction shared by the gate and rewrite rescoring paths.

The feature order is part of the serialized-booster contract.  The vector and
matrix helpers are the only supported ways to turn named rows into model input;
both prediction entry points use them with the caller-provided, unchanged
:class:`~contracts.PredictionContext`.
"""

from __future__ import annotations

import hashlib
import math
import re
import statistics
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import TypeAlias

from contracts import PredictionContext

FeatureValue: TypeAlias = float | int | str | None
FeatureRow: TypeAlias = dict[str, FeatureValue]
FeatureVector: TypeAlias = tuple[float, ...]

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

_FENCE_OPEN = re.compile(r"^\s*(`{3,}|~{3,})[^\n]*$")
_PATH = re.compile(
    r"(?<![\w])(?:"
    r"(?:[A-Za-z]:[\\/]|/|\.\.?[\\/])?"
    r"(?:[\w@.+-]+[\\/])+[\w@.+-]+"
    r"|[\w@+-]+\.[A-Za-z][\w+-]{0,11}"
    r")"
)
_CATEGORY_SPACE = 1_000_003


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
    if FEATURE_ORDER != tuple(flattened):
        raise RuntimeError("FEATURE_ORDER must preserve the declared bucket order")


def _require_finite_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite")
    return result


def _validate_context(ctx: PredictionContext) -> None:
    missing = PredictionContext.__required_keys__.difference(ctx)
    if missing:
        raise ValueError(f"Prediction context is missing keys: {sorted(missing)}")
    if not isinstance(ctx["target_model"], str) or not ctx["target_model"].strip():
        raise ValueError("ctx.target_model must be a non-empty string")
    project = ctx["project"]
    if project is not None and not isinstance(project, str):
        raise ValueError("ctx.project must be a string or None")
    turn_index = ctx["session_turn_index"]
    if (
        isinstance(turn_index, bool)
        or not isinstance(turn_index, int)
        or turn_index < 0
    ):
        raise ValueError("ctx.session_turn_index must be a non-negative integer")
    recent_costs = ctx["recent_costs"]
    if not isinstance(recent_costs, list):
        raise ValueError("ctx.recent_costs must be a list")
    for index, cost in enumerate(recent_costs):
        numeric_cost = _require_finite_number(cost, f"ctx.recent_costs[{index}]")
        if numeric_cost < 0:
            raise ValueError(f"ctx.recent_costs[{index}] must be non-negative")
    completion_ratio = _require_finite_number(
        ctx["completion_ratio_median"],
        "ctx.completion_ratio_median",
    )
    if completion_ratio < 0:
        raise ValueError("ctx.completion_ratio_median must be non-negative")


def _estimate_tokens(text: str) -> int:
    """Return the deterministic approximation used by the trained feature set."""

    if not text:
        return 0
    # Four Unicode characters per token is deliberately simple and stable.  A
    # production artifact must be trained with this same featurizer.
    return max(1, math.ceil(len(text) / 4))


def _normalized_nonempty_lines(prompt: str) -> list[str]:
    return [" ".join(line.split()) for line in prompt.splitlines() if line.strip()]


def _fenced_block_count(lines: Sequence[str]) -> int:
    count = 0
    opening_marker: str | None = None
    for line in lines:
        if opening_marker is None:
            match = _FENCE_OPEN.match(line)
            if match is not None:
                opening_marker = match.group(1)
                count += 1
            continue
        stripped = line.strip()
        marker_character = re.escape(opening_marker[0])
        if re.fullmatch(
            rf"{marker_character}{{{len(opening_marker)},}}",
            stripped,
        ):
            opening_marker = None
    return count


def _duplicate_line_ratio(normalized_lines: Sequence[str]) -> float:
    if not normalized_lines:
        return 0.0
    unique_count = len(set(normalized_lines))
    return (len(normalized_lines) - unique_count) / len(normalized_lines)


def _repeated_block_token_share(normalized_lines: Sequence[str]) -> float:
    """Estimate the prompt share occupied by recurring block content.

    Exact line recurrence is intentionally used here.  It recognizes repeated
    multi-line dumps in linear time (including the 200-line counterfactual in
    the model acceptance test) without an expensive pairwise substring scan.
    All occurrences of recurring lines count toward the share; duplicate-line
    ratio separately captures only the redundant copies.
    """

    if not normalized_lines:
        return 0.0
    counts = Counter(normalized_lines)
    token_counts = [_estimate_tokens(line) for line in normalized_lines]
    total = sum(token_counts)
    if total == 0:
        return 0.0
    repeated = sum(
        tokens
        for line, tokens in zip(normalized_lines, token_counts, strict=True)
        if counts[line] > 1
    )
    return repeated / total


def _path_token_count(prompt: str) -> int:
    count = 0
    for match in _PATH.finditer(prompt):
        # Count the meaningful path components, not punctuation separators.
        count += len(re.findall(r"[A-Za-z0-9]+", match.group(0)))
    return count


def build_feature_row(prompt: str, ctx: PredictionContext) -> FeatureRow:
    """Build one named model row without mutating ``ctx``.

    Categorical context values remain readable in the named row.  The numeric
    encoding needed by LightGBM happens only in ``feature_vector_from_row``.
    """

    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be non-empty")
    _validate_context(ctx)

    lines = prompt.splitlines()
    normalized_lines = _normalized_nonempty_lines(prompt)
    recent_costs = [float(cost) for cost in ctx["recent_costs"]]
    recent_last = recent_costs[-1] if recent_costs else 0.0
    recent_mean = statistics.fmean(recent_costs) if recent_costs else 0.0
    recent_p50 = statistics.median(recent_costs) if recent_costs else 0.0

    return {
        "prompt_token_estimate": _estimate_tokens(prompt),
        "line_count": max(1, len(lines)),
        "fenced_block_count": _fenced_block_count(lines),
        "duplicate_line_ratio": _duplicate_line_ratio(normalized_lines),
        "repeated_block_token_share": _repeated_block_token_share(
            normalized_lines
        ),
        "path_token_count": _path_token_count(prompt),
        "whitespace_ratio": sum(character.isspace() for character in prompt)
        / len(prompt),
        "target_model": ctx["target_model"],
        "project": ctx["project"],
        "session_turn_index": ctx["session_turn_index"],
        "recent_cost_last": recent_last,
        "recent_cost_mean": recent_mean,
        "recent_cost_p50": recent_p50,
        # This post-execution-only feature is always imputed from the frozen
        # context.  Gate and rescore therefore receive the identical value.
        "completion_ratio": float(ctx["completion_ratio_median"]),
    }


def _encode_category(value: str | None) -> float:
    if value is None or not value:
        return 0.0
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    # A bounded integer remains exactly representable as a float and is stable
    # across Python processes (unlike the built-in hash function).
    return float(1 + int.from_bytes(digest[:8], "big") % _CATEGORY_SPACE)


def feature_vector_from_row(row: Mapping[str, FeatureValue]) -> FeatureVector:
    """Convert a named row to the booster's fixed-order numeric vector."""

    missing = set(FEATURE_ORDER).difference(row)
    if missing:
        raise ValueError(f"Feature row is missing keys: {sorted(missing)}")

    values: list[float] = []
    for feature in FEATURE_ORDER:
        value = row[feature]
        if feature in {"target_model", "project"}:
            if value is not None and not isinstance(value, str):
                raise ValueError(f"{feature} must be a string or None")
            values.append(_encode_category(value))
            continue
        values.append(_require_finite_number(value, feature))
    return tuple(values)


def build_feature_vector(prompt: str, ctx: PredictionContext) -> FeatureVector:
    """Build one ordered numeric feature vector."""

    return feature_vector_from_row(build_feature_row(prompt, ctx))


def build_feature_matrix(
    prompts: Sequence[str],
    ctx: PredictionContext,
) -> list[list[float]]:
    """Build a batch matrix under one frozen prediction context."""

    return [list(build_feature_vector(prompt, ctx)) for prompt in prompts]


validate_feature_contract()
