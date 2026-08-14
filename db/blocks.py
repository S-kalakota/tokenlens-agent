"""Pure block fingerprinting for the derived block-library tier."""

import hashlib
import math
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from contracts import BlockFingerprint, BlockKind

WINDOW_LINE_COUNT = 20
_OPENING_FENCE = re.compile(r"^\s*(`{3,}|~{3,})[^\n]*$")


def normalize_block(text: str) -> str:
    """Normalize all whitespace before hashing recurring content."""

    return " ".join(text.split())


def hash_block(normalized_text: str) -> str:
    """Return a stable SHA-256 digest for normalized block text."""

    if not normalized_text:
        raise ValueError("normalized_text must be non-empty")
    return hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()


def _estimated_token_count(normalized_text: str) -> int:
    # A tokenizer-specific count is supplied by Agent B. Four characters per
    # token is a deterministic Phase 0 estimate for the block contract.
    return max(1, math.ceil(len(normalized_text) / 4))


def _fingerprint(
    text: str,
    *,
    kind: BlockKind,
    start_line: int,
    end_line: int,
) -> BlockFingerprint | None:
    normalized = normalize_block(text)
    if not normalized:
        return None
    return {
        "block_hash": hash_block(normalized),
        "kind": kind,
        "normalized_text": normalized,
        "start_line": start_line,
        "end_line": end_line,
        "token_count": _estimated_token_count(normalized),
    }


def _fenced_blocks(lines: list[str]) -> Iterator[BlockFingerprint]:
    opening_marker: str | None = None
    content_start = 0

    for line_index, line in enumerate(lines):
        if opening_marker is None:
            match = _OPENING_FENCE.match(line)
            if match:
                opening_marker = match.group(1)
                content_start = line_index + 1
            continue

        stripped = line.strip()
        closing = re.fullmatch(
            rf"{re.escape(opening_marker[0])}{{{len(opening_marker)},}}",
            stripped,
        )
        if not closing:
            continue

        fingerprint = _fingerprint(
            "\n".join(lines[content_start:line_index]),
            kind="fenced_code",
            start_line=content_start + 1,
            end_line=line_index,
        )
        if fingerprint is not None:
            yield fingerprint
        opening_marker = None


def _line_windows(
    lines: list[str],
    window_lines: int,
) -> Iterator[BlockFingerprint]:
    if window_lines <= 0:
        raise ValueError("window_lines must be positive")

    for start in range(0, len(lines) - window_lines + 1):
        fingerprint = _fingerprint(
            "\n".join(lines[start : start + window_lines]),
            kind="line_window",
            start_line=start + 1,
            end_line=start + window_lines,
        )
        if fingerprint is not None:
            yield fingerprint


def fingerprint_prompt(
    prompt: str,
    *,
    window_lines: int = WINDOW_LINE_COUNT,
) -> list[BlockFingerprint]:
    """Hash every fenced block and every fixed-size sliding line window."""

    lines = prompt.splitlines()
    return [
        *_fenced_blocks(lines),
        *_line_windows(lines, window_lines),
    ]


def upsert_block_fingerprints(
    collection: Any,
    prompt: str,
    user_id: str,
    project: str | None,
    *,
    now: datetime | None = None,
) -> list[BlockFingerprint]:
    """Fingerprint one prompt and increment each distinct library block once.

    A prompt can yield the same digest as both a fenced block and a line
    window. De-duplicating hashes here prevents overlap from inflating the
    cross-prompt occurrence counter.
    """

    if not user_id.strip():
        raise ValueError("user_id must be non-empty")
    timestamp = now or datetime.now(UTC)
    unique: dict[str, BlockFingerprint] = {}
    for fingerprint in fingerprint_prompt(prompt):
        unique.setdefault(fingerprint["block_hash"], fingerprint)

    for fingerprint in unique.values():
        collection.update_one(
            {
                "user_id": user_id,
                "project": project,
                "block_hash": fingerprint["block_hash"],
            },
            {
                "$setOnInsert": {
                    "kind": fingerprint["kind"],
                    "normalized_text": fingerprint["normalized_text"],
                    "token_count": fingerprint["token_count"],
                    "collapse_accepted": 0,
                    "first_seen_at": timestamp,
                },
                "$set": {"last_seen_at": timestamp},
                "$inc": {"occurrences": 1},
            },
            upsert=True,
        )
    return list(unique.values())


def increment_collapse_acceptance(
    collection: Any,
    *,
    user_id: str,
    project: str | None,
    block_hashes: list[str],
    session: Any | None = None,
) -> int:
    """Record an accepted collapse for its source blocks."""

    unique_hashes = list(dict.fromkeys(block_hashes))
    if not unique_hashes:
        return 0
    options = {"session": session} if session is not None else {}
    result = collection.update_many(
        {
            "user_id": user_id,
            "project": project,
            "block_hash": {"$in": unique_hashes},
        },
        {"$inc": {"collapse_accepted": 1}},
        **options,
    )
    return int(getattr(result, "modified_count", 0))
