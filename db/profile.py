"""Derived user-profile helpers and atomic outcome materialization."""

from collections.abc import Mapping
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


def profile_from_document(
    document: dict[str, Any] | None,
    user_id: str,
) -> UserProfile:
    """Normalize a stored profile, including documents from older versions."""

    profile = empty_profile(user_id)
    if not document:
        return profile
    for field in (
        "cost_quantiles",
        "accept_rate_by_type",
        "calibration",
        "completion_ratio_median",
    ):
        value = document.get(field)
        if value is not None:
            profile[field] = value  # type: ignore[literal-required]
    stored_projects = document.get("per_project")
    if isinstance(stored_projects, Mapping):
        normalized_projects: dict[str, Any] = {}
        for project, value in stored_projects.items():
            if not isinstance(value, Mapping):
                continue
            normalized_projects[str(project)] = {
                "cost_quantiles": value.get(
                    "cost_quantiles",
                    {"p40": 0.0, "p50": 0.0, "p90": 0.0, "n": 0},
                ),
                "calibration": value.get(
                    "calibration", {"bias": 0.0, "mae": 0.0, "n": 0}
                ),
                "completion_ratio_median": value.get(
                    "completion_ratio_median",
                    DEFAULT_COMPLETION_RATIO_MEDIAN,
                ),
            }
        profile["per_project"] = normalized_projects
    updated_at = document.get("updated_at")
    profile["updated_at"] = (
        updated_at.isoformat()
        if isinstance(updated_at, datetime)
        else updated_at
    )
    return profile


def _validated_type_segment(suggestion_type: str) -> str:
    if not suggestion_type or not suggestion_type.replace("_", "a").isalnum():
        raise ValueError(
            "suggestion_type must contain only letters, digits, underscores"
        )
    return suggestion_type


def _project_segment(project: str) -> str:
    """Escape a project name for use as one MongoDB document-path segment."""

    if not project.strip():
        raise ValueError("project must be non-empty when supplied")
    return project.replace(".", "\uff0e").replace("$", "\uff04")


def _calibration_fields(prefix: str, residual: float) -> dict[str, Any]:
    old_n = {"$ifNull": [f"${prefix}.n", 0]}
    new_n = {"$add": [old_n, 1]}
    return {
        f"{prefix}.n": new_n,
        f"{prefix}.bias": {
            "$divide": [
                {
                    "$add": [
                        {
                            "$multiply": [
                                {"$ifNull": [f"${prefix}.bias", 0.0]},
                                old_n,
                            ]
                        },
                        residual,
                    ]
                },
                new_n,
            ]
        },
        f"{prefix}.mae": {
            "$divide": [
                {
                    "$add": [
                        {
                            "$multiply": [
                                {"$ifNull": [f"${prefix}.mae", 0.0]},
                                old_n,
                            ]
                        },
                        abs(residual),
                    ]
                },
                new_n,
            ]
        },
    }


def build_outcome_profile_update(
    suggestion_type: str,
    accepted: bool,
    *,
    predicted_savings: float,
    actual_savings: float | None,
    project: str | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Build one aggregation-pipeline update for outcome-derived memory.

    Acceptance counts and calibration residuals are updated together in one
    document write. Sparse rates are shrunk toward the global prior until ten
    observations exist. Cost quantiles and completion ratios are populated by
    session writes/backfill and are preserved by this pipeline.
    """

    type_key = _validated_type_segment(suggestion_type)
    if predicted_savings < 0:
        raise ValueError("predicted_savings must be non-negative")
    if actual_savings is not None and not isinstance(actual_savings, (int, float)):
        raise ValueError("actual_savings must be numeric when supplied")

    timestamp = now or datetime.now(UTC)
    prefix = f"accept_rate_by_type.{type_key}"
    old_accepted = {"$ifNull": [f"${prefix}.accepted", 0]}
    old_total = {"$ifNull": [f"${prefix}.total", 0]}
    new_accepted = {"$add": [old_accepted, int(accepted)]}
    new_total = {"$add": [old_total, 1]}
    mature_rate = {"$divide": [new_accepted, new_total]}
    shrunk_rate = {
        "$divide": [
            {
                "$add": [
                    new_accepted,
                    GLOBAL_ACCEPTANCE_PRIOR * PRIOR_STRENGTH,
                ]
            },
            {"$add": [new_total, PRIOR_STRENGTH]},
        ]
    }

    set_stage: dict[str, Any] = {
        "cost_quantiles": {
            "$ifNull": [
                "$cost_quantiles",
                {"p40": 0.0, "p50": 0.0, "p90": 0.0, "n": 0},
            ]
        },
        "per_project": {"$ifNull": ["$per_project", {}]},
        "completion_ratio_median": {
            "$ifNull": [
                "$completion_ratio_median",
                DEFAULT_COMPLETION_RATIO_MEDIAN,
            ]
        },
        f"{prefix}.accepted": new_accepted,
        f"{prefix}.total": new_total,
        f"{prefix}.rate": {
            "$cond": [
                {"$gte": [new_total, MIN_TYPE_OBSERVATIONS]},
                mature_rate,
                shrunk_rate,
            ]
        },
        "updated_at": timestamp,
    }

    pipeline: list[dict[str, Any]] = []
    if actual_savings is None:
        set_stage["calibration"] = {
            "$ifNull": ["$calibration", {"bias": 0.0, "mae": 0.0, "n": 0}]
        }
    else:
        # A positive residual means predicted savings were optimistic. Rescore
        # subtracts this learned bias from future savings estimates.
        residual = predicted_savings - actual_savings
        set_stage.update(_calibration_fields("calibration", residual))

    pipeline.append({"$set": set_stage})
    if project is not None and actual_savings is not None:
        # ``per_project`` is initialized by the first stage. A separate stage
        # avoids a MongoDB path conflict between setting that parent and its
        # nested calibration fields in the same operation.
        project_root = f"per_project.{_project_segment(project)}"
        project_fields = _calibration_fields(
            f"{project_root}.calibration", residual
        )
        project_fields[f"{project_root}.cost_quantiles"] = {
            "$ifNull": [
                f"${project_root}.cost_quantiles",
                {"p40": 0.0, "p50": 0.0, "p90": 0.0, "n": 0},
            ]
        }
        project_fields[f"{project_root}.completion_ratio_median"] = {
            "$ifNull": [
                f"${project_root}.completion_ratio_median",
                DEFAULT_COMPLETION_RATIO_MEDIAN,
            ]
        }
        pipeline.append({"$set": project_fields})
    return pipeline


def apply_outcome_profile_update(
    collection: Any,
    *,
    user_id: str,
    suggestion_type: str,
    accepted: bool,
    predicted_savings: float,
    actual_savings: float | None,
    project: str | None = None,
    session: Any | None = None,
) -> None:
    """Apply the outcome pipeline, optionally inside a Mongo transaction."""

    kwargs = {"upsert": True}
    if session is not None:
        kwargs["session"] = session
    collection.update_one(
        {"_id": user_id},
        build_outcome_profile_update(
            suggestion_type,
            accepted,
            predicted_savings=predicted_savings,
            actual_savings=actual_savings,
            project=project,
        ),
        **kwargs,
    )
