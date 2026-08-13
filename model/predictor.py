"""Cost-prediction contract and Phase 0 fixture implementation."""

from copy import deepcopy
from pathlib import Path
from typing import cast

from config import load_stub_data, require_stub
from contracts import CostBand, PredictionContext


BOOSTER_PATH = Path(__file__).with_name("booster.txt")


def _validate_inputs(prompt: str, ctx: PredictionContext) -> None:
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")

    required_context_keys = PredictionContext.__required_keys__
    missing = required_context_keys.difference(ctx)
    if missing:
        raise ValueError(f"Prediction context is missing keys: {sorted(missing)}")


def _stub_prediction() -> CostBand:
    prediction = cast(CostBand, deepcopy(load_stub_data()["prediction"]))
    if not prediction["p10"] <= prediction["p50"] <= prediction["p90"]:
        raise ValueError("Stub prediction quantiles must be monotonic")
    return prediction


def predict(prompt: str, ctx: PredictionContext) -> CostBand:
    """Predict one prompt's cost under an immutable context."""

    require_stub("Real cost prediction")
    _validate_inputs(prompt, ctx)
    return _stub_prediction()


def predict_many(
    prompts: list[str],
    ctx: PredictionContext,
) -> list[CostBand]:
    """Predict a batch under the exact same context.

    The fixture path preserves the batch-shaped contract without pretending to
    implement Agent A's single LightGBM batch call.
    """

    require_stub("Real batched cost prediction")
    for prompt in prompts:
        _validate_inputs(prompt, ctx)
    return [_stub_prediction() for _ in prompts]
