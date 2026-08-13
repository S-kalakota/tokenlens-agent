"""Derived user-profile schema and pure Phase 0 helpers."""

from datetime import UTC, datetime
from typing import Any

from contracts import AcceptanceStats, UserProfile


GLOBAL_ACCEPTANCE_PRIOR = 0.35
PRIOR_STRENGTH = 5
MIN_TYPE_OBSERVATIONS = 10
DEFAULT_COMPLETION_RATIO_MEDIAN = 0.35


def shrunk_acceptance_stats(
    accepted: int,
    total: int,
    *,
    prior: float = GLOBAL_ACCEPTANCE_PRIOR,
    prior_strength: int = PRIOR_STRENGTH,
    shrink_below: int = MIN_TYPE_OBSERVATIONS,
) -> AcceptanceStats:
    """Combine raw outcomes with a global prior for sparse histories."""

    if accepted < 0 or total < 0 or accepted > total:
        raise ValueError("accepted and total must satisfy 0 <= accepted <= total")
    if not 0.0 <= prior <= 1.0:
        raise ValueError("prior must be between zero and one")
    if prior_strength < 0:
        raise ValueError("prior_strength must be non-negative")
    if shrink_below <= 0:
        raise ValueError("shrink_below must be positive")

    if total >= shrink_below:
        rate = accepted / total
    else:
        denominator = total + prior_strength
        rate = prior if denominator == 0 else (
            accepted + prior * prior_strength
        ) / denominator
    return {"rate": rate, "accepted": accepted, "total": total}


def empty_profile(user_id: str) -> UserProfile:
    """Return a valid cold-start profile without inventing observations."""

    if not user_id.strip():
        raise ValueError("user_id must be non-empty")
    return {
        "user_id": user_id,
        "cost_quantiles": {"p40": 0.0, "p50": 0.0, "p90": 0.0, "n": 0},
        "per_project": {},
        "accept_rate_by_type": {},
        "calibration": {"bias": 0.0, "mae": 0.0, "n": 0},
        "completion_ratio_median": DEFAULT_COMPLETION_RATIO_MEDIAN,
        "updated_at": datetime.now(UTC).isoformat(),
    }


def build_outcome_profile_update(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    """Build the atomic Mongo aggregation-pipeline update.

    The database implementation belongs to Part 3 (Agent B). The declared
    return type makes explicit that this is one pipeline update, not a batch
    recomputation.
    """

    del args, kwargs
    raise NotImplementedError(
        "The profile aggregation pipeline is implemented in Part 3 (Agent B)"
    )
