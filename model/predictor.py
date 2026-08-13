"""Cached LightGBM cost prediction with a deterministic development fallback."""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

from config import load_stub_data, stub_enabled
from contracts import CostBand, PredictionContext
from model.featurizer import (
    FEATURE_ORDER,
    FeatureRow,
    build_feature_row,
    feature_vector_from_row,
)

BOOSTER_PATH = Path(__file__).with_name("booster.txt")
HEURISTIC_FALLBACK_ENV = "TOKENLENS_MODEL_FALLBACK"
_HEURISTIC_VALUES = frozenset({"heuristic", "1", "true", "yes", "on"})
_STUB_REFERENCE_TOKENS = 4.0
_STUB_TOKENS_TO_COST = 8.0


class PredictorUnavailableError(NotImplementedError):
    """Raised when real inference was requested without a usable artifact."""


class PredictorContractError(RuntimeError):
    """Raised when a booster does not match the committed feature contract."""


def _validate_booster_contract(booster: Any) -> None:
    num_feature = getattr(booster, "num_feature", None)
    if callable(num_feature):
        actual_count = int(num_feature())
        if actual_count != len(FEATURE_ORDER):
            raise PredictorContractError(
                "LightGBM artifact expects "
                f"{actual_count} features, but TokenLens builds {len(FEATURE_ORDER)}"
            )

    feature_name = getattr(booster, "feature_name", None)
    if not callable(feature_name):
        return
    names = tuple(str(name) for name in feature_name())
    generic_names = tuple(f"Column_{index}" for index in range(len(names)))
    if names and names != generic_names and names != FEATURE_ORDER:
        raise PredictorContractError(
            "LightGBM feature names/order do not match model.featurizer.FEATURE_ORDER"
        )


def _load_booster(path: Path = BOOSTER_PATH) -> tuple[Any | None, str | None]:
    """Load and validate a booster once; optional dependencies stay optional."""

    try:
        header = path.read_text(encoding="utf-8", errors="replace")[:512]
    except OSError as error:
        return None, f"booster artifact could not be read: {error}"
    if not header.strip() or "placeholder" in header.lower():
        return None, f"{path} is a placeholder, not an exported LightGBM artifact"

    try:
        import lightgbm as lgb  # type: ignore[import-not-found]
    except ImportError:
        return None, "the lightgbm package is not installed"

    try:
        booster = lgb.Booster(model_file=str(path))
        _validate_booster_contract(booster)
    except Exception as error:  # LightGBM exposes several artifact exceptions.
        return None, f"LightGBM artifact could not be loaded: {error}"
    return booster, None


# Import-time initialization is intentional: model loading is cold-path work and
# must never recur in the first-Enter gate or candidate-rescore paths.
_BOOSTER, _BOOSTER_UNAVAILABLE_REASON = _load_booster()


def _validate_inputs(prompt: str, ctx: PredictionContext) -> None:
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be non-empty")

    required_context_keys = PredictionContext.__required_keys__
    missing = required_context_keys.difference(ctx)
    if missing:
        raise ValueError(f"Prediction context is missing keys: {sorted(missing)}")
    bias = ctx["calibration_bias"]
    if isinstance(bias, bool) or not isinstance(bias, (int, float)):
        raise ValueError("ctx.calibration_bias must be numeric")
    if not math.isfinite(float(bias)):
        raise ValueError("ctx.calibration_bias must be finite")


def _stub_prediction(prompt: str, ctx: PredictionContext) -> CostBand:
    """Return a deterministic, prompt-sensitive fixture prediction.

    The committed band remains the calibration point for tiny Phase 0 prompts,
    preserving the original fixture assertions. Longer and structurally
    duplicated prompts add a deterministic cost adjustment, which lets the
    walking-skeleton graph produce meaningful counterfactual savings.
    """

    base = cast(CostBand, deepcopy(load_stub_data()["prediction"]))
    if not base["p10"] <= base["p50"] <= base["p90"]:
        raise ValueError("Stub prediction quantiles must be monotonic")

    row = build_feature_row(prompt, ctx)
    prompt_tokens = _numeric(row, "prompt_token_estimate")
    duplicate_ratio = _numeric(row, "duplicate_line_ratio")
    repeated_share = _numeric(row, "repeated_block_token_share")
    structural_tokens = prompt_tokens * (
        0.30 * duplicate_ratio + 0.35 * repeated_share
    )
    excess_tokens = max(0.0, prompt_tokens - _STUB_REFERENCE_TOKENS)
    adjustment = (excess_tokens + structural_tokens) * _STUB_TOKENS_TO_COST

    return {
        "p10": base["p10"] + adjustment * 0.80,
        "p50": base["p50"] + adjustment,
        "p90": base["p90"] + adjustment * 1.25,
    }


def _heuristic_enabled() -> bool:
    return (
        os.getenv(HEURISTIC_FALLBACK_ENV, "").strip().lower()
        in _HEURISTIC_VALUES
    )


def _numeric(row: FeatureRow, feature: str) -> float:
    value = row[feature]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PredictorContractError(f"Heuristic feature {feature} is not numeric")
    return float(value)


def _heuristic_points(rows: Sequence[FeatureRow]) -> list[float]:
    """Provide explicit, deterministic development-only point estimates.

    This path is never selected silently.  Set
    ``TOKENLENS_MODEL_FALLBACK=heuristic`` when a real artifact is unavailable.
    """

    predictions: list[float] = []
    for row in rows:
        prompt_tokens = _numeric(row, "prompt_token_estimate")
        completion_ratio = _numeric(row, "completion_ratio")
        duplicate_ratio = _numeric(row, "duplicate_line_ratio")
        repeated_share = _numeric(row, "repeated_block_token_share")
        fenced_blocks = _numeric(row, "fenced_block_count")
        recent_mean = _numeric(row, "recent_cost_mean")

        structural_multiplier = (
            1.0
            + 0.30 * duplicate_ratio
            + 0.35 * repeated_share
            + 0.02 * min(fenced_blocks, 5.0)
        )
        # The bounded history term makes the fallback context-sensitive without
        # allowing old high-cost sessions to swamp the current prompt shape.
        history_term = min(recent_mean * 0.05, prompt_tokens * 0.5)
        predictions.append(
            max(
                0.0,
                prompt_tokens * (1.0 + completion_ratio) * structural_multiplier
                + history_term,
            )
        )
    return predictions


def _as_plain_data(value: Any) -> Any:
    tolist = getattr(value, "tolist", None)
    return tolist() if callable(tolist) else value


def _finite_prediction(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PredictorContractError("Booster predictions must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise PredictorContractError("Booster predictions must be finite")
    return result


def _prediction_rows(raw: Any, expected_rows: int) -> list[tuple[float, ...]]:
    """Normalize LightGBM point or three-quantile output to rows."""

    raw = _as_plain_data(raw)
    if expected_rows == 1 and isinstance(raw, (int, float)):
        return [(_finite_prediction(raw),)]
    if not isinstance(raw, (list, tuple)):
        raise PredictorContractError("Booster returned an unsupported prediction shape")

    plain = [_as_plain_data(value) for value in raw]
    if expected_rows == 1 and len(plain) == 3 and all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in plain
    ):
        return [tuple(_finite_prediction(value) for value in plain)]

    if len(plain) == expected_rows and all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in plain
    ):
        return [(_finite_prediction(value),) for value in plain]

    if len(plain) == expected_rows:
        rows: list[tuple[float, ...]] = []
        for value in plain:
            if not isinstance(value, (list, tuple)) or len(value) not in {1, 3}:
                raise PredictorContractError(
                    "Each booster output row must contain one point or three quantiles"
                )
            rows.append(tuple(_finite_prediction(item) for item in value))
        return rows

    if len(plain) == expected_rows * 3 and all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in plain
    ):
        return [
            tuple(
                _finite_prediction(item)
                for item in plain[index : index + 3]
            )
            for index in range(0, len(plain), 3)
        ]
    raise PredictorContractError(
        f"Booster returned {len(plain)} outputs for {expected_rows} prompts"
    )


def _to_cost_band(values: tuple[float, ...], bias: float) -> CostBand:
    if len(values) == 1:
        point = max(0.0, values[0])
        quantiles = (point * 0.80, point, point * 1.25)
    elif len(values) == 3:
        # Independent quantile boosters can cross.  Sorting keeps the public
        # CostBand contract monotonic while preserving all three estimates.
        quantiles = tuple(sorted(max(0.0, value) for value in values))
    else:  # Defensive: _prediction_rows already guarantees one or three.
        raise PredictorContractError("Expected one point or three quantiles")

    corrected = tuple(max(0.0, value + bias) for value in quantiles)
    return {"p10": corrected[0], "p50": corrected[1], "p90": corrected[2]}


def _real_or_heuristic_predictions(
    prompts: Sequence[str],
    ctx: PredictionContext,
) -> list[CostBand]:
    rows = [build_feature_row(prompt, ctx) for prompt in prompts]
    bias = float(ctx["calibration_bias"])

    if _BOOSTER is None:
        if not _heuristic_enabled():
            reason = _BOOSTER_UNAVAILABLE_REASON or "no booster was loaded"
            raise PredictorUnavailableError(
                f"Real cost prediction is unavailable: {reason}. Replace "
                f"{BOOSTER_PATH.name} with a valid artifact and install lightgbm, "
                f"or explicitly set {HEURISTIC_FALLBACK_ENV}=heuristic for "
                "development-only estimates."
            )
        raw_rows = [(point,) for point in _heuristic_points(rows)]
    else:
        _validate_booster_contract(_BOOSTER)
        # This is deliberately one call for the whole candidate set.  Building
        # rows in a Python loop is feature extraction; booster inference itself
        # remains genuinely batched.
        matrix = [list(feature_vector_from_row(row)) for row in rows]
        raw_rows = _prediction_rows(_BOOSTER.predict(matrix), len(prompts))

    return [_to_cost_band(values, bias) for values in raw_rows]


def predict(prompt: str, ctx: PredictionContext) -> CostBand:
    """Predict one prompt's cost under an immutable context."""

    _validate_inputs(prompt, ctx)
    if stub_enabled():
        return _stub_prediction(prompt, ctx)
    return _real_or_heuristic_predictions([prompt], ctx)[0]


def predict_many(
    prompts: list[str],
    ctx: PredictionContext,
) -> list[CostBand]:
    """Predict a batch in one booster call under the exact same context."""

    if not isinstance(prompts, list):
        raise ValueError("prompts must be a list")
    if not prompts:
        return []
    for prompt in prompts:
        _validate_inputs(prompt, ctx)
    if stub_enabled():
        return [_stub_prediction(prompt, ctx) for prompt in prompts]
    return _real_or_heuristic_predictions(prompts, ctx)
