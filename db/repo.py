"""The only repository interface consumed by the graph and MCP layers."""

import hashlib
import os
from collections.abc import Sequence
from copy import deepcopy
from typing import cast

from config import load_stub_data, require_stub
from contracts import (
    BlockHit,
    CostBand,
    PredictionContext,
    RetrievedExample,
    ScoredRewrite,
    UserProfile,
)


def _require_identity(value: str, field: str) -> None:
    if not value.strip():
        raise ValueError(f"{field} must be non-empty")


def load_context(
    user_id: str,
    session_id: str,
    project: str | None,
) -> tuple[PredictionContext, UserProfile]:
    """Load all derived memory needed by the graph in one repository call."""

    require_stub("Real context loading")
    _require_identity(user_id, "user_id")
    _require_identity(session_id, "session_id")

    fixture = load_stub_data()
    ctx = cast(PredictionContext, deepcopy(fixture["context"]))
    profile = cast(UserProfile, deepcopy(fixture["profile"]))

    profile["user_id"] = user_id
    ctx["user_id"] = user_id
    ctx["session_id"] = session_id
    ctx["project"] = project
    ctx["target_model"] = os.getenv(
        "TOKENLENS_TARGET_MODEL",
        ctx["target_model"],
    )

    project_profile = profile["per_project"].get(project) if project else None
    if project_profile is not None:
        ctx["completion_ratio_median"] = project_profile[
            "completion_ratio_median"
        ]
        ctx["calibration_bias"] = project_profile["calibration"]["bias"]
    else:
        ctx["completion_ratio_median"] = profile["completion_ratio_median"]
        ctx["calibration_bias"] = profile["calibration"]["bias"]

    return ctx, profile


def match_blocks(
    prompt: str,
    user_id: str,
    project: str | None,
) -> list[BlockHit]:
    """Match prompt fingerprints against this user's block library."""

    require_stub("Real block matching")
    _require_identity(user_id, "user_id")
    del project
    if "repeated_fixture" not in prompt:
        return []
    return cast(list[BlockHit], deepcopy(load_stub_data()["block_hits"]))


def log_session(
    prompt: str,
    predicted_cost: CostBand,
    ctx: PredictionContext,
) -> str:
    """Append a prompt event and return its repository identifier."""

    require_stub("Real session logging")
    _require_identity(ctx["session_id"], "ctx.session_id")
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    del predicted_cost
    digest = hashlib.sha256(
        f"{ctx['session_id']}\0{prompt}".encode("utf-8")
    ).hexdigest()[:16]
    return f"stub-session-{digest}"


def find_similar(
    prompt: str,
    user_id: str,
    k: int = 3,
) -> list[RetrievedExample]:
    """Retrieve accepted, positive-savings examples scoped to one user."""

    require_stub("Real vector retrieval")
    _require_identity(user_id, "user_id")
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    if k < 0:
        raise ValueError("k must be non-negative")
    examples = cast(
        list[RetrievedExample],
        deepcopy(load_stub_data()["retrieved_examples"]),
    )
    return examples[:k]


def log_suggestions(
    session_id: str,
    rewrites: Sequence[ScoredRewrite],
) -> list[str]:
    """Append generated suggestion events and return their identifiers."""

    require_stub("Real suggestion logging")
    _require_identity(session_id, "session_id")
    return [f"stub-suggestion-{index + 1}" for index, _ in enumerate(rewrites)]


def record_outcome(
    suggestion_id: str,
    accepted: bool,
    actual_savings: float | None,
) -> None:
    """Write an outcome and atomically update profile and block memory."""

    require_stub("Real outcome recording")
    _require_identity(suggestion_id, "suggestion_id")
    if actual_savings is not None and actual_savings < 0:
        raise ValueError("actual_savings must be non-negative when supplied")
    del accepted
