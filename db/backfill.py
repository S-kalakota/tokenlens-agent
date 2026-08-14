"""Replay exported TokenLens JSON or JSONL history into MongoDB."""

import argparse
import hashlib
import json
import os
import sys
from collections.abc import Iterable, Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from config import stub_enabled
from db.blocks import (
    fingerprint_prompt,
    increment_collapse_acceptance,
    upsert_block_fingerprints,
)
from db.client import get_database
from db.indexes import ensure_indexes
from db.profile import apply_outcome_profile_update
from db.repo import refresh_profile_from_sessions


def _timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value.strip():
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return datetime.now(UTC)


def _cost_band(record: Mapping[str, Any]) -> dict[str, float]:
    supplied = record.get("predicted_cost")
    if isinstance(supplied, Mapping):
        p50 = float(supplied.get("p50", 0.0))
        return {
            "p10": float(supplied.get("p10", p50)),
            "p50": p50,
            "p90": float(supplied.get("p90", p50)),
        }
    p50 = float(
        record.get(
            "predicted_tokens",
            record.get("estimated_tokens", record.get("token_count", 0.0)),
        )
    )
    return {"p10": p50, "p50": p50, "p90": p50}


def _stable_id(prefix: str, *parts: Any) -> str:
    digest = hashlib.sha256(
        "\0".join(str(part) for part in parts).encode("utf-8")
    ).hexdigest()[:24]
    return f"backfill-{prefix}-{digest}"


def _was_inserted(result: Any) -> bool:
    return getattr(result, "upserted_id", None) is not None


def replay_history(
    records: Iterable[Mapping[str, Any]],
    *,
    database: Any | None = None,
    default_user_id: str | None = None,
) -> dict[str, int]:
    """Idempotently replay raw history into episodic and derived tiers."""

    stats = {"sessions": 0, "suggestions": 0, "blocks": 0, "skipped": 0}
    if stub_enabled() and database is None:
        # Fixture mode intentionally never attempts a real connection.
        stats["skipped"] = sum(1 for _ in records)
        return stats

    selected = database if database is not None else get_database()
    fallback_user = default_user_id or os.getenv("TOKENLENS_USER_ID", "local-user")
    affected_users: set[str] = set()
    for record in records:
        prompt = str(record.get("prompt_text", record.get("prompt", "")))
        user_id = str(record.get("user_id", fallback_user)).strip()
        if not prompt.strip() or not user_id:
            stats["skipped"] += 1
            continue
        session_id = str(
            record.get("session_id", record.get("conversation_id", "backfill"))
        )
        project = record.get("project")
        timestamp = _timestamp(record.get("timestamp", record.get("created_at")))
        predicted_cost = _cost_band(record)
        document_id = str(
            record.get("_id")
            or _stable_id("session", user_id, session_id, timestamp, prompt)
        )
        fingerprints = fingerprint_prompt(prompt)
        session_document = {
            "_id": document_id,
            "user_id": user_id,
            "session_id": session_id,
            "analysis_id": record.get("analysis_id"),
            "prompt_text": prompt,
            "predicted_cost": predicted_cost,
            "actual_cost": record.get(
                "actual_cost", record.get("actual_tokens")
            ),
            "project": project,
            "target_model": record.get(
                "target_model", record.get("model", "unknown")
            ),
            "turn_index": int(record.get("turn_index", 0)),
            "block_hashes": list(
                dict.fromkeys(item["block_hash"] for item in fingerprints)
            ),
            "completion_ratio": record.get("completion_ratio"),
            "timestamp": timestamp,
        }
        result = selected["sessions"].update_one(
            {"_id": document_id}, {"$setOnInsert": session_document}, upsert=True
        )
        if not _was_inserted(result):
            stats["skipped"] += 1
            continue

        stats["sessions"] += 1
        affected_users.add(user_id)
        blocks = upsert_block_fingerprints(
            selected["block_library"],
            prompt,
            user_id,
            project,
            now=timestamp,
        )
        stats["blocks"] += len(blocks)

        suggestions = record.get("suggestions", [])
        if not isinstance(suggestions, list):
            continue
        for index, suggestion in enumerate(suggestions):
            if not isinstance(suggestion, Mapping):
                continue
            suggestion_id = str(
                suggestion.get("_id")
                or suggestion.get("suggestion_id")
                or _stable_id("suggestion", document_id, index)
            )
            accepted = suggestion.get("accepted")
            actual_savings = suggestion.get("actual_savings")
            suggestion_document = {
                "_id": suggestion_id,
                "user_id": user_id,
                "session_id": session_id,
                "analysis_id": suggestion.get(
                    "analysis_id", record.get("analysis_id")
                ),
                # Nested suggestions belong to this exact imported prompt turn.
                "source_session_document_id": document_id,
                "project": project,
                "suggestion_type": suggestion.get(
                    "suggestion_type", suggestion.get("type", "dedupe")
                ),
                "rewrite_text": suggestion.get(
                    "rewrite_text", suggestion.get("rewrite", "")
                ),
                "rationale": suggestion.get("rationale", "Imported history"),
                "predicted_savings": float(
                    suggestion.get("predicted_savings", 0.0)
                ),
                "accepted": accepted,
                "actual_savings": actual_savings,
                "final_prompt": suggestion.get("final_prompt"),
                "source_block_hashes": suggestion.get(
                    "source_block_hashes", []
                ),
                "timestamp": _timestamp(
                    suggestion.get("timestamp", timestamp)
                ),
            }
            suggestion_result = selected["suggestions"].update_one(
                {"_id": suggestion_id},
                {"$setOnInsert": suggestion_document},
                upsert=True,
            )
            if not _was_inserted(suggestion_result):
                continue
            stats["suggestions"] += 1
            if isinstance(accepted, bool):
                calibrated_savings = (
                    float(actual_savings)
                    if actual_savings is not None
                    else None
                )
                apply_outcome_profile_update(
                    selected["user_profile"],
                    user_id=user_id,
                    suggestion_type=str(suggestion_document["suggestion_type"]),
                    accepted=accepted,
                    predicted_savings=float(
                        suggestion_document["predicted_savings"]
                    ),
                    actual_savings=calibrated_savings,
                    project=project,
                )
                if (
                    accepted
                    and suggestion_document["suggestion_type"]
                    == "collapse_block"
                ):
                    increment_collapse_acceptance(
                        selected["block_library"],
                        user_id=user_id,
                        project=project,
                        block_hashes=list(
                            suggestion_document["source_block_hashes"]
                        ),
                    )

    for user_id in affected_users:
        refresh_profile_from_sessions(user_id, database=selected)
    return stats


def _records_from_json(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, list):
        for record in value:
            if isinstance(record, Mapping):
                yield record
        return
    if isinstance(value, Mapping):
        sessions = value.get("sessions")
        if isinstance(sessions, list):
            yield from _records_from_json(sessions)
        else:
            yield value
        return
    raise ValueError("history input must contain a JSON object or array")


def read_records(stream: TextIO) -> Iterator[Mapping[str, Any]]:
    """Read either one JSON value or newline-delimited JSON objects."""

    contents = stream.read()
    if not contents.strip():
        return
    try:
        yield from _records_from_json(json.loads(contents))
        return
    except json.JSONDecodeError:
        pass
    for line_number, line in enumerate(contents.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL on line {line_number}: {exc}") from exc
        if not isinstance(record, Mapping):
            raise ValueError(f"JSONL line {line_number} must contain an object")
        yield record


def _open_input(path: str) -> TextIO:
    if path == "-":
        return sys.stdin
    return Path(path).open(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="-", help="JSON/JSONL or -")
    parser.add_argument("--user-id", help="fallback owner for unscoped exports")
    parser.add_argument(
        "--ensure-indexes",
        action="store_true",
        help="create regular and Automated Embedding indexes before replay",
    )
    parser.add_argument(
        "--skip-vector-index",
        action="store_true",
        help="with --ensure-indexes, create only regular indexes",
    )
    args = parser.parse_args(argv)

    database = None if stub_enabled() else get_database()
    if args.ensure_indexes and database is not None:
        ensure_indexes(database, include_vector=not args.skip_vector_index)
    stream = _open_input(args.path)
    try:
        stats = replay_history(
            read_records(stream), database=database, default_user_id=args.user_id
        )
    finally:
        if stream is not sys.stdin:
            stream.close()
    print(json.dumps(stats, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
