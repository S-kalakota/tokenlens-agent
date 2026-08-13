"""The only repository interface consumed outside :mod:`db`.

The fixture branch is deliberately dependency-free.  Real branches obtain a
cached database lazily, which keeps module imports safe when PyMongo is not
installed and makes the boundary straightforward to replace with test doubles.
"""

import hashlib
import math
import os
import statistics
import uuid
from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, cast

from config import load_stub_data, stub_enabled
from contracts import (
    BlockHit,
    CostBand,
    PredictionContext,
    RetrievedExample,
    ScoredRewrite,
    UserProfile,
)
from db.blocks import (
    fingerprint_prompt,
    increment_collapse_acceptance,
    upsert_block_fingerprints,
)
from db.client import get_database
from db.indexes import VECTOR_INDEX_CONTRACT
from db.profile import (
    DEFAULT_COMPLETION_RATIO_MEDIAN,
    apply_outcome_profile_update,
    profile_from_document,
)

_RECENT_COST_LIMIT = 20
_DECISIONS = frozenset({"accepted", "skipped", "edited", "failed"})
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def _database() -> Any:
    return get_database()


def _now() -> datetime:
    return datetime.now(UTC)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def _require_identity(value: str, field: str) -> None:
    if not value.strip():
        raise ValueError(f"{field} must be non-empty")


def _require_prompt(prompt: str) -> None:
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")


def _retain_raw_prompts() -> bool:
    return os.getenv("TOKENLENS_RETAIN_RAW_PROMPTS", "0").lower() in _TRUE_VALUES


def _validate_cost(cost: CostBand) -> None:
    if not cost["p10"] <= cost["p50"] <= cost["p90"]:
        raise ValueError("cost quantiles must satisfy p10 <= p50 <= p90")


def _usage_number(usage: Mapping[str, Any], key: str) -> float | None:
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) and numeric >= 0 else None


def _completion_ratio_from_usage(
    usage: Mapping[str, Any] | None,
) -> float | None:
    """Derive completion/input token ratio from Claude or OpenAI usage data."""

    if not usage:
        return None
    explicit = _usage_number(usage, "completion_ratio")
    if explicit is not None:
        return explicit

    output_tokens = _usage_number(usage, "output_tokens")
    input_keys = (
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    )
    input_values = [_usage_number(usage, key) for key in input_keys]
    known_inputs = [value for value in input_values if value is not None]
    if output_tokens is not None and known_inputs:
        input_tokens = sum(known_inputs)
        return output_tokens / input_tokens if input_tokens > 0 else None

    # OpenAI-compatible result payloads use prompt/completion terminology.
    prompt_tokens = _usage_number(usage, "prompt_tokens")
    completion_tokens = _usage_number(usage, "completion_tokens")
    if prompt_tokens and completion_tokens is not None:
        return completion_tokens / prompt_tokens
    return None


def _project_key(project: str) -> str:
    return project.replace(".", "\uff0e").replace("$", "\uff04")


def _restore_project_keys(profile: UserProfile) -> UserProfile:
    profile["per_project"] = {
        key.replace("\uff0e", ".").replace("\uff04", "$"): value
        for key, value in profile["per_project"].items()
    }
    return profile


def _find_recent(collection: Any, query: dict[str, Any], limit: int) -> list[Any]:
    cursor = collection.find(query)
    cursor = cursor.sort("timestamp", -1)
    return list(cursor.limit(limit))


def load_context(
    user_id: str,
    session_id: str,
    project: str | None,
) -> tuple[PredictionContext, UserProfile]:
    """Load all derived and recent episodic memory in one repository call."""

    _require_identity(user_id, "user_id")
    _require_identity(session_id, "session_id")

    if stub_enabled():
        fixture = load_stub_data()
        ctx = cast(PredictionContext, deepcopy(fixture["context"]))
        profile = cast(UserProfile, deepcopy(fixture["profile"]))
        profile["user_id"] = user_id
        ctx["user_id"] = user_id
        ctx["session_id"] = session_id
        ctx["project"] = project
        ctx["target_model"] = os.getenv(
            "TOKENLENS_TARGET_MODEL", ctx["target_model"]
        )
    else:
        database = _database()
        profile = profile_from_document(
            database["user_profile"].find_one({"_id": user_id}), user_id
        )
        profile = _restore_project_keys(profile)
        recent_documents = _find_recent(
            database["sessions"], {"user_id": user_id}, _RECENT_COST_LIMIT
        )
        recent_costs = [
            float(
                item["actual_cost"]
                if item.get("actual_cost") is not None
                else item.get("predicted_cost", {}).get("p50", 0.0)
            )
            for item in reversed(recent_documents)
        ]
        recent_costs = [value for value in recent_costs if value >= 0]
        ctx = {
            "user_id": user_id,
            "session_id": session_id,
            "project": project,
            "target_model": os.getenv(
                "TOKENLENS_TARGET_MODEL", "anthropic/claude-sonnet-4"
            ),
            "session_turn_index": database["sessions"].count_documents(
                {"user_id": user_id, "session_id": session_id}
            ),
            "recent_costs": recent_costs,
            "completion_ratio_median": profile["completion_ratio_median"],
            "calibration_bias": profile["calibration"]["bias"],
        }

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
    """Count this prompt's blocks, then return its known library matches."""

    _require_prompt(prompt)
    _require_identity(user_id, "user_id")
    if stub_enabled():
        remembered = cast(list[BlockHit], deepcopy(load_stub_data()["block_hits"]))
        current = {
            item["block_hash"]: item for item in fingerprint_prompt(prompt)
        }
        # Fixture mode follows the production hash contract. Merely mentioning
        # a remembered block's label must not trigger a deterministic route.
        return [
            {
                **hit,
                **current[hit["block_hash"]],
                "occurrences": hit["occurrences"],
                "collapse_accepted": hit["collapse_accepted"],
            }
            for hit in remembered
            if hit["block_hash"] in current
        ]

    database = _database()
    fingerprints = upsert_block_fingerprints(
        database["block_library"], prompt, user_id, project
    )
    by_hash = {item["block_hash"]: item for item in fingerprints}
    if not by_hash:
        return []
    documents = database["block_library"].find(
        {
            "user_id": user_id,
            "project": project,
            "block_hash": {"$in": list(by_hash)},
        }
    )
    hits: list[BlockHit] = []
    for document in documents:
        fingerprint = by_hash.get(document.get("block_hash"))
        if fingerprint is None:
            continue
        hits.append(
            {
                **fingerprint,
                "occurrences": int(document.get("occurrences", 0)),
                "collapse_accepted": int(document.get("collapse_accepted", 0)),
            }
        )
    return sorted(
        hits,
        key=lambda item: (item["collapse_accepted"], item["occurrences"]),
        reverse=True,
    )


def log_session(
    prompt: str,
    predicted_cost: CostBand,
    ctx: PredictionContext,
    *,
    actual_cost: float | None = None,
    claude_session_id: str | None = None,
    usage: Mapping[str, Any] | None = None,
    analysis_id: str | None = None,
) -> str:
    """Append one prompt actually approved for sending."""

    _require_prompt(prompt)
    _require_identity(ctx["session_id"], "ctx.session_id")
    _require_identity(ctx["user_id"], "ctx.user_id")
    _validate_cost(predicted_cost)
    if actual_cost is not None and actual_cost < 0:
        raise ValueError("actual_cost must be non-negative when supplied")
    if stub_enabled():
        digest = hashlib.sha256(
            f"{ctx['session_id']}\0{prompt}".encode()
        ).hexdigest()[:16]
        return f"stub-session-{digest}"

    database = _database()
    document_id = _new_id("session")
    fingerprints = fingerprint_prompt(prompt)
    resolved_analysis_id = analysis_id or _sent_analysis_id(
        database,
        prompt,
        ctx,
        claude_session_id,
    )
    completion_ratio = _completion_ratio_from_usage(usage)
    database["sessions"].insert_one(
        {
            "_id": document_id,
            "user_id": ctx["user_id"],
            "session_id": ctx["session_id"],
            "analysis_id": resolved_analysis_id,
            "prompt_text": prompt,
            "predicted_cost": dict(predicted_cost),
            "actual_cost": actual_cost,
            "project": ctx["project"],
            "target_model": ctx["target_model"],
            "turn_index": ctx["session_turn_index"],
            "claude_session_id": claude_session_id,
            "usage": dict(usage) if usage is not None else None,
            "completion_ratio": completion_ratio,
            "block_hashes": list(
                dict.fromkeys(item["block_hash"] for item in fingerprints)
            ),
            "timestamp": _now(),
        }
    )
    if resolved_analysis_id is not None:
        # Suggestions exist before a prompt is approved and sent. Link them to
        # the exact resulting session document as soon as that document exists.
        database["suggestions"].update_many(
            {
                "analysis_id": resolved_analysis_id,
                "source_session_document_id": None,
            },
            {"$set": {"source_session_document_id": document_id}},
        )

    # Materialize live cost distributions and completion medians immediately.
    # Savings-residual calibration is intentionally preserved here and updated
    # only by record_outcome, which has the correct predicted-vs-actual delta.
    refresh_profile_from_sessions(ctx["user_id"], database=database)
    return document_id


def _sent_analysis_id(
    database: Any,
    prompt: str,
    ctx: PredictionContext,
    claude_session_id: str | None,
) -> str | None:
    """Resolve one unambiguous sent analysis without conversation-wide guessing."""

    query: dict[str, Any] = {
        "user_id": ctx["user_id"],
        "session_id": ctx["session_id"],
        "selected_prompt_hash": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "send_status": "sent",
    }
    if claude_session_id:
        query["claude_session_id"] = claude_session_id
    collection = database["draft_analyses"]
    try:
        cursor = collection.find(query, {"analysis_id": 1})
        documents = list(cursor.sort("sent_at", -1).limit(2))
    except (AttributeError, TypeError):
        # A minimal collection double cannot prove uniqueness, so its one
        # result is only useful for isolated tests. Production PyMongo always
        # takes the bounded-find branch above.
        document = collection.find_one(query)
        documents = [document] if document else []
    if len(documents) != 1:
        return None
    value = documents[0].get("analysis_id")
    return value if isinstance(value, str) and value else None


def find_similar(
    prompt: str,
    user_id: str,
    k: int = 3,
) -> list[RetrievedExample]:
    """Retrieve only accepted, positive-savings suggestions for this user."""

    _require_prompt(prompt)
    _require_identity(user_id, "user_id")
    if k < 0:
        raise ValueError("k must be non-negative")
    if k == 0:
        return []
    if stub_enabled():
        examples = cast(
            list[RetrievedExample],
            deepcopy(load_stub_data()["retrieved_examples"]),
        )
        return examples[:k]

    contract = VECTOR_INDEX_CONTRACT
    pipeline: list[dict[str, Any]] = [
        {
            "$vectorSearch": {
                "index": contract["name"],
                "path": contract["source_field"],
                "query": prompt,
                "model": os.getenv(
                    "TOKENLENS_EMBEDDING_MODEL", contract["model"]
                ),
                "filter": {"user_id": user_id},
                "numCandidates": max(50, k * 20),
                "limit": max(k * 4, k),
            }
        },
        {"$set": {"similarity": {"$meta": "vectorSearchScore"}}},
        {
            "$lookup": {
                "from": "suggestions",
                "let": {
                    "source_document_id": "$_id",
                    "source_analysis_id": "$analysis_id",
                },
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {
                                        "$or": [
                                            {
                                                "$and": [
                                                    {
                                                        "$ne": [
                                                            "$source_session_document_id",
                                                            None,
                                                        ]
                                                    },
                                                    {
                                                        "$eq": [
                                                            "$source_session_document_id",
                                                            "$$source_document_id",
                                                        ]
                                                    },
                                                ]
                                            },
                                            {
                                                # Safe legacy fallback: an
                                                # analysis ID identifies one
                                                # frozen draft exactly. Never
                                                # fall back to conversation ID.
                                                "$and": [
                                                    {
                                                        "$eq": [
                                                            {
                                                                "$ifNull": [
                                                                    "$source_session_document_id",
                                                                    None,
                                                                ]
                                                            },
                                                            None,
                                                        ]
                                                    },
                                                    {
                                                        "$ne": [
                                                            "$$source_analysis_id",
                                                            None,
                                                        ]
                                                    },
                                                    {
                                                        "$eq": [
                                                            "$analysis_id",
                                                            "$$source_analysis_id",
                                                        ]
                                                    },
                                                ]
                                            },
                                        ]
                                    },
                                    {"$eq": ["$user_id", user_id]},
                                    {"$eq": ["$accepted", True]},
                                    {"$gt": ["$actual_savings", 0]},
                                ]
                            }
                        }
                    }
                ],
                "as": "accepted_suggestions",
            }
        },
        {"$unwind": "$accepted_suggestions"},
        {"$sort": {"similarity": -1}},
        {"$limit": k},
        {
            "$project": {
                "_id": 0,
                "prompt_excerpt": {"$substrCP": ["$prompt_text", 0, 200]},
                "rewrite": "$accepted_suggestions.rewrite_text",
                "rationale": "$accepted_suggestions.rationale",
                "suggestion_type": "$accepted_suggestions.suggestion_type",
                "actual_savings": "$accepted_suggestions.actual_savings",
                "similarity": 1,
            }
        },
    ]
    return cast(
        list[RetrievedExample],
        list(_database()[contract["collection"]].aggregate(pipeline)),
    )


def _latest_session(database: Any, session_id: str) -> dict[str, Any] | None:
    try:
        return database["sessions"].find_one(
            {"session_id": session_id}, sort=[("timestamp", -1)]
        )
    except TypeError:  # small test doubles sometimes omit the ``sort`` option
        documents = _find_recent(
            database["sessions"], {"session_id": session_id}, 1
        )
        return documents[0] if documents else None


def log_suggestions(
    session_id: str,
    rewrites: Sequence[ScoredRewrite],
    *,
    user_id: str | None = None,
    analysis_id: str | None = None,
    project: str | None = None,
    source_block_hashes: Sequence[str] = (),
) -> list[str]:
    """Append generated suggestions and return stable string identifiers."""

    _require_identity(session_id, "session_id")
    if stub_enabled():
        return [f"stub-suggestion-{index + 1}" for index, _ in enumerate(rewrites)]
    if not rewrites:
        return []

    database = _database()
    session_document = _latest_session(database, session_id) or {}
    resolved_user = user_id or session_document.get("user_id")
    if not resolved_user:
        raise ValueError(
            "user_id is required when no logged session supplies ownership"
        )
    resolved_project = (
        project if project is not None else session_document.get("project")
    )
    now = _now()
    documents: list[dict[str, Any]] = []
    ids: list[str] = []
    for rewrite in rewrites:
        suggestion_id = _new_id("suggestion")
        ids.append(suggestion_id)
        rewrite_block_hashes = rewrite.get(
            "source_block_hashes", list(source_block_hashes)
        )
        documents.append(
            {
                "_id": suggestion_id,
                "user_id": resolved_user,
                "session_id": session_id,
                "analysis_id": analysis_id,
                "source_session_document_id": None,
                "project": resolved_project,
                "suggestion_type": rewrite["suggestion_type"],
                "rewrite_text": rewrite["rewrite"],
                "rationale": rewrite["rationale"],
                "predicted_cost": dict(rewrite["predicted_cost"]),
                "predicted_savings": float(rewrite["estimated_savings"]),
                "accepted": None,
                "actual_savings": None,
                "final_prompt": None,
                "source_block_hashes": list(dict.fromkeys(rewrite_block_hashes)),
                "timestamp": now,
            }
        )
    database["suggestions"].insert_many(documents, ordered=True)
    if analysis_id is not None:
        result = database["draft_analyses"].update_one(
            {"analysis_id": analysis_id},
            {
                "$set": {"updated_at": now},
                "$addToSet": {
                    "candidate_ids": {"$each": ids},
                    "suggestion_ids": {"$each": ids},
                },
            },
        )
        _require_updated(result, f"analysis {analysis_id}")
    return ids


def log_draft_analysis(analysis: Mapping[str, Any]) -> str:
    """Persist one immutable first-Enter analysis identity."""

    analysis_id = str(analysis.get("analysis_id", ""))
    user_id = str(analysis.get("user_id", ""))
    session_id = str(
        analysis.get("optimization_session_id", analysis.get("session_id", ""))
    )
    _require_identity(analysis_id, "analysis.analysis_id")
    _require_identity(user_id, "analysis.user_id")
    _require_identity(session_id, "analysis.session_id")
    prompt = str(analysis.get("prompt", analysis.get("original_prompt", "")))
    _require_prompt(prompt)
    prompt_hash = str(
        analysis.get("prompt_hash", analysis.get("original_prompt_hash", ""))
    )
    expected_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    if prompt_hash != expected_hash:
        raise ValueError("analysis prompt_hash does not match exact UTF-8 bytes")
    if stub_enabled():
        return analysis_id

    timestamp = _now()
    _database()["draft_analyses"].insert_one(
        {
            "_id": analysis_id,
            "analysis_id": analysis_id,
            "user_id": user_id,
            "session_id": session_id,
            "project": analysis.get("project"),
            "draft_version": int(analysis.get("draft_version", 0)),
            "prompt_hash": prompt_hash,
            "prompt_text": prompt if _retain_raw_prompts() else None,
            "original_cost": analysis.get("original_cost"),
            "candidate_ids": list(
                analysis.get("candidate_ids", analysis.get("suggestion_ids", []))
            ),
            "suggestion_ids": list(analysis.get("suggestion_ids", [])),
            "decision": None,
            "selected_prompt_hash": None,
            "send_status": None,
            "send_attempt_id": None,
            "send_resume_session_id": None,
            "send_attempt_started_at": None,
            "send_attempt_completed_at": None,
            "claude_session_id": None,
            "usage": None,
            "error": None,
            "created_at": timestamp,
            "decided_at": None,
            "sent_at": None,
            "updated_at": timestamp,
        }
    )
    return analysis_id


def _require_updated(result: Any, entity: str) -> None:
    if int(getattr(result, "matched_count", 0)) == 0:
        raise KeyError(f"Unknown {entity}")


def record_decision(
    analysis_id: str,
    decision: str,
    selected_prompt_hash: str | None,
) -> None:
    """Record the current terminal decision without losing edit abandonment.

    Accept/Skip is captured as soon as the user chooses it. If they edit before
    any send attempt, that provisional choice becomes ``edited``. Identical
    repeats are idempotent, which is required when a failure event is observed
    by both the optimization service and its wrapper.
    """

    _require_identity(analysis_id, "analysis_id")
    if decision not in _DECISIONS:
        raise ValueError(f"Unsupported decision: {decision}")
    if decision in {"accepted", "skipped"} and not selected_prompt_hash:
        raise ValueError("accepted/skipped decisions require selected_prompt_hash")
    if stub_enabled():
        return

    database = _database()
    if decision == "edited":
        unresolved: dict[str, Any] = {
            "analysis_id": analysis_id,
            "$or": [
                {"decision": None},
                {
                    "decision": {"$in": ["accepted", "skipped"]},
                    "send_status": None,
                },
            ],
        }
    else:
        unresolved = {"analysis_id": analysis_id, "decision": None}
    now = _now()
    result = database["draft_analyses"].update_one(
        unresolved,
        {
            "$set": {
                "decision": decision,
                "selected_prompt_hash": selected_prompt_hash,
                "decided_at": now,
                "updated_at": now,
            }
        },
    )
    if int(getattr(result, "matched_count", 0)):
        return

    existing = database["draft_analyses"].find_one(
        {"analysis_id": analysis_id},
        {"decision": 1, "selected_prompt_hash": 1},
    )
    if existing is None:
        raise KeyError(f"Unknown analysis {analysis_id}")
    if (
        existing.get("decision") == decision
        and existing.get("selected_prompt_hash") == selected_prompt_hash
    ):
        return
    raise ValueError(
        f"analysis {analysis_id} already has decision "
        f"{existing.get('decision')!r}"
    )


def record_send_attempt(
    analysis_id: str,
    send_attempt_id: str,
    selected_prompt_hash: str,
    claude_session_id: str | None,
) -> None:
    """Durably reserve one explicit send before Claude can be launched.

    A pending attempt cannot be replaced. Only a definitely failed attempt may
    be followed by a new explicit retry, preventing a restart or persistence
    race from turning an ambiguous delivery into an automatic duplicate.
    """

    _require_identity(analysis_id, "analysis_id")
    _require_identity(send_attempt_id, "send_attempt_id")
    _require_identity(selected_prompt_hash, "selected_prompt_hash")
    if stub_enabled():
        return

    database = _database()
    now = _now()
    result = database["draft_analyses"].update_one(
        {
            "analysis_id": analysis_id,
            "decision": {"$in": ["accepted", "skipped"]},
            "selected_prompt_hash": selected_prompt_hash,
            "$or": [
                {"send_status": None},
                {"send_status": "send_failed"},
            ],
        },
        {
            "$set": {
                "send_status": "pending",
                "send_attempt_id": send_attempt_id,
                "send_resume_session_id": claude_session_id,
                "claude_session_id": None,
                "usage": None,
                "error": None,
                "sent_at": None,
                "send_attempt_started_at": now,
                "send_attempt_completed_at": None,
                "updated_at": now,
            }
        },
    )
    if int(getattr(result, "matched_count", 0)):
        return

    existing = database["draft_analyses"].find_one(
        {"analysis_id": analysis_id},
        {
            "decision": 1,
            "selected_prompt_hash": 1,
            "send_status": 1,
            "send_attempt_id": 1,
        },
    )
    if existing is None:
        raise KeyError(f"Unknown analysis {analysis_id}")
    if (
        existing.get("send_status") == "pending"
        and existing.get("send_attempt_id") == send_attempt_id
        and existing.get("selected_prompt_hash") == selected_prompt_hash
    ):
        return
    if existing.get("send_status") == "pending":
        raise ValueError(
            f"analysis {analysis_id} already has an unresolved send attempt"
        )
    if existing.get("send_status") == "sent":
        raise ValueError(f"analysis {analysis_id} has already been sent")
    raise ValueError(
        f"analysis {analysis_id} is not ready for the selected prompt hash"
    )


def record_send_result(
    analysis_id: str,
    claude_session_id: str | None,
    usage: Mapping[str, Any] | None,
    error: str | None = None,
    *,
    send_attempt_id: str,
) -> None:
    """Complete the matching pending attempt and no other send attempt."""

    _require_identity(analysis_id, "analysis_id")
    _require_identity(send_attempt_id, "send_attempt_id")
    if error is None and not claude_session_id:
        raise ValueError("a successful send requires claude_session_id")
    if stub_enabled():
        return

    now = _now()
    database = _database()
    terminal_status = "send_failed" if error else "sent"
    result = database["draft_analyses"].update_one(
        {
            "analysis_id": analysis_id,
            "send_attempt_id": send_attempt_id,
            "send_status": "pending",
        },
        {
            "$set": {
                "send_status": terminal_status,
                "claude_session_id": None if error else claude_session_id,
                "usage": dict(usage) if usage is not None else None,
                "error": error,
                "sent_at": None if error else now,
                "send_attempt_completed_at": now,
                "updated_at": now,
            }
        },
    )
    if int(getattr(result, "matched_count", 0)):
        return

    # Retrying an acknowledged terminal write is harmless. A different or
    # still-pending attempt must never be completed accidentally.
    existing = database["draft_analyses"].find_one(
        {"analysis_id": analysis_id},
        {
            "send_attempt_id": 1,
            "send_status": 1,
            "claude_session_id": 1,
            "usage": 1,
            "error": 1,
        },
    )
    if existing is None:
        raise KeyError(f"Unknown analysis {analysis_id}")
    if (
        existing.get("send_attempt_id") == send_attempt_id
        and existing.get("send_status") == terminal_status
        and existing.get("claude_session_id")
        == (None if error else claude_session_id)
        and existing.get("usage")
        == (dict(usage) if usage is not None else None)
        and existing.get("error") == error
    ):
        return
    raise ValueError(
        f"analysis {analysis_id} has no matching pending send attempt "
        f"{send_attempt_id}"
    )


def record_outcome(
    suggestion_id: str,
    accepted: bool,
    actual_savings: float | None,
    *,
    final_prompt: str | None = None,
) -> None:
    """Write an outcome and immediately update behavior-changing memory.

    Repeating an identical write is idempotent. Contradictory rewrites of an
    already recorded outcome are rejected so acceptance counts cannot drift.
    """

    _require_identity(suggestion_id, "suggestion_id")
    if actual_savings is not None and not isinstance(actual_savings, (int, float)):
        raise ValueError("actual_savings must be numeric when supplied")
    if stub_enabled():
        return

    database = _database()
    suggestion = database["suggestions"].find_one({"_id": suggestion_id})
    if suggestion is None:
        raise KeyError(f"Unknown suggestion {suggestion_id}")
    if suggestion.get("accepted") is not None:
        same = (
            suggestion.get("accepted") is accepted
            and suggestion.get("actual_savings") == actual_savings
            and (
                final_prompt is None
                or suggestion.get("final_prompt") == final_prompt
            )
        )
        if same:
            return
        raise ValueError("suggestion outcome has already been recorded")

    def apply(session: Any | None = None) -> None:
        update_options = {"session": session} if session is not None else {}
        result = database["suggestions"].update_one(
            {"_id": suggestion_id, "accepted": None},
            {
                "$set": {
                    "accepted": accepted,
                    "actual_savings": actual_savings,
                    "final_prompt": final_prompt,
                    "outcome_recorded_at": _now(),
                }
            },
            **update_options,
        )
        _require_updated(result, f"unresolved suggestion {suggestion_id}")
        apply_outcome_profile_update(
            database["user_profile"],
            user_id=suggestion["user_id"],
            suggestion_type=suggestion["suggestion_type"],
            accepted=accepted,
            predicted_savings=float(suggestion.get("predicted_savings", 0.0)),
            actual_savings=actual_savings,
            project=suggestion.get("project"),
            session=session,
        )
        if accepted and suggestion.get("suggestion_type") == "collapse_block":
            increment_collapse_acceptance(
                database["block_library"],
                user_id=suggestion["user_id"],
                project=suggestion.get("project"),
                block_hashes=list(suggestion.get("source_block_hashes", [])),
                session=session,
            )

    # The suggestion, profile, and recurring-block facts must commit together.
    # Atlas supports transactions; refusing a non-transactional deployment is
    # safer than acknowledging an outcome whose derived memory was only partly
    # materialized and cannot be retried without double-counting.
    try:
        client = database.client
        with client.start_session() as session:
            with session.start_transaction():
                apply(session)
    except (AttributeError, NotImplementedError) as exc:
        raise RuntimeError(
            "record_outcome requires a transaction-capable MongoDB deployment"
        ) from exc
    except Exception as exc:
        if getattr(exc, "code", None) == 20:
            raise RuntimeError(
                "record_outcome requires a transaction-capable MongoDB deployment"
            ) from exc
        raise


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return float(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction)


def refresh_profile_from_sessions(
    user_id: str,
    *,
    database: Any | None = None,
) -> UserProfile:
    """Materialize cost and completion facts without overwriting calibration.

    Calibration is a predicted-savings residual learned by ``record_outcome``.
    A session's actual-cost residual is a different quantity, so neither live
    session refreshes nor backfills may replace that outcome-derived memory.
    """

    _require_identity(user_id, "user_id")
    selected = database if database is not None else _database()
    profile = _restore_project_keys(
        profile_from_document(
            selected["user_profile"].find_one({"_id": user_id}), user_id
        )
    )
    sessions = list(selected["sessions"].find({"user_id": user_id}))

    def facts(
        rows: Sequence[Mapping[str, Any]],
    ) -> tuple[dict[str, Any], float | None]:
        costs = [
            float(
                row["actual_cost"]
                if row.get("actual_cost") is not None
                else row.get("predicted_cost", {}).get("p50", 0.0)
            )
            for row in rows
        ]
        costs = [cost for cost in costs if cost >= 0]
        ratios: list[float] = []
        for row in rows:
            value = row.get("completion_ratio")
            if value is None and isinstance(row.get("usage"), Mapping):
                value = _completion_ratio_from_usage(row["usage"])
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            ratio = float(value)
            if math.isfinite(ratio) and ratio >= 0:
                ratios.append(ratio)
        quantiles = {
            "p40": _quantile(costs, 0.4),
            "p50": _quantile(costs, 0.5),
            "p90": _quantile(costs, 0.9),
            "n": len(costs),
        }
        completion = float(statistics.median(ratios)) if ratios else None
        return quantiles, completion

    quantiles, completion = facts(sessions)
    projects: dict[str, Any] = {}
    project_names = {
        str(row["project"])
        for row in sessions
        if row.get("project") is not None
    }
    for project in project_names:
        project_rows = [row for row in sessions if row.get("project") == project]
        project_quantiles, project_completion = facts(project_rows)
        projects[_project_key(project)] = {
            "cost_quantiles": project_quantiles,
            "completion_ratio_median": project_completion,
        }
    now = _now()
    pipeline: list[dict[str, Any]] = [
        {
            "$set": {
                "cost_quantiles": quantiles,
                "accept_rate_by_type": {
                    "$ifNull": ["$accept_rate_by_type", {}]
                },
                "calibration": {
                    "$ifNull": [
                        "$calibration",
                        {"bias": 0.0, "mae": 0.0, "n": 0},
                    ]
                },
                "per_project": {"$ifNull": ["$per_project", {}]},
                "completion_ratio_median": (
                    completion
                    if completion is not None
                    else {
                        "$ifNull": [
                            "$completion_ratio_median",
                            DEFAULT_COMPLETION_RATIO_MEDIAN,
                        ]
                    }
                ),
                "updated_at": now,
            }
        }
    ]
    if projects:
        project_updates: dict[str, Any] = {}
        for project_key, project_facts in projects.items():
            prefix = f"per_project.{project_key}"
            project_updates[f"{prefix}.cost_quantiles"] = project_facts[
                "cost_quantiles"
            ]
            project_completion = project_facts["completion_ratio_median"]
            project_updates[f"{prefix}.completion_ratio_median"] = (
                project_completion
                if project_completion is not None
                else {
                    "$ifNull": [
                        f"${prefix}.completion_ratio_median",
                        DEFAULT_COMPLETION_RATIO_MEDIAN,
                    ]
                }
            )
            # Initialize cold project segments, but retain the savings
            # residual written by outcome materialization when one exists.
            project_updates[f"{prefix}.calibration"] = {
                "$ifNull": [
                    f"${prefix}.calibration",
                    {"bias": 0.0, "mae": 0.0, "n": 0},
                ]
            }
        pipeline.append({"$set": project_updates})
    selected["user_profile"].update_one(
        {"_id": user_id},
        pipeline,
        upsert=True,
    )
    profile["cost_quantiles"] = quantiles
    for project in project_names:
        project_facts = projects[_project_key(project)]
        current_project = profile["per_project"].get(project)
        project_calibration = (
            current_project.get(
                "calibration", {"bias": 0.0, "mae": 0.0, "n": 0}
            )
            if current_project is not None
            else {"bias": 0.0, "mae": 0.0, "n": 0}
        )
        project_completion = project_facts["completion_ratio_median"]
        if project_completion is None:
            project_completion = (
                current_project.get(
                    "completion_ratio_median",
                    DEFAULT_COMPLETION_RATIO_MEDIAN,
                )
                if current_project is not None
                else DEFAULT_COMPLETION_RATIO_MEDIAN
            )
        profile["per_project"][project] = {
            "cost_quantiles": project_facts["cost_quantiles"],
            "calibration": project_calibration,
            "completion_ratio_median": project_completion,
        }
    if completion is not None:
        profile["completion_ratio_median"] = completion
    profile["updated_at"] = now.isoformat()
    return profile
