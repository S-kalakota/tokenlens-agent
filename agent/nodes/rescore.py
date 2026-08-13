"""Counterfactual model scoring for proposed rewrites."""

from typing import Any

from agent.state import AgentState
from contracts import ScoredRewrite
from model.predictor import predict_many


def rescore(state: AgentState) -> dict[str, Any]:
    """Batch-predict candidates using the gate's unchanged context."""

    candidates = state.get("candidate_rewrites", [])
    if not candidates:
        return {"scored_rewrites": []}

    # Deliberately pass the exact object assembled by gate. Re-loading context
    # here would invalidate the counterfactual savings comparison.
    ctx = state["ctx"]
    candidate_costs = predict_many(
        [candidate["rewrite"] for candidate in candidates],
        ctx,
    )
    if len(candidate_costs) != len(candidates):
        raise RuntimeError("predict_many returned the wrong number of predictions")

    original_p50 = state["predicted_cost"]["p50"]
    # ``predict`` applies the same project calibration bias to both the gate
    # and counterfactual candidate bands, so it cancels in their raw delta.
    # Outcome memory stores predicted_savings - actual_savings: a positive bias
    # means prior estimates were optimistic and must reduce displayed savings;
    # a negative bias means they were pessimistic and increases it.
    calibration_bias = float(ctx["calibration_bias"])
    scored: list[ScoredRewrite] = []
    for candidate, predicted_cost in zip(candidates, candidate_costs, strict=True):
        savings = original_p50 - predicted_cost["p50"] - calibration_bias
        if savings <= 0:
            continue
        scored.append(
            {
                **candidate,
                "predicted_cost": predicted_cost,
                "estimated_savings": savings,
            }
        )
    return {"scored_rewrites": scored}
