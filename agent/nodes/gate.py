"""Cost gate and memory-driven routing."""

import os
from typing import Any

from agent.state import AgentState
from contracts import BlockHit, CandidateRewrite
from db.repo import load_context, match_blocks
from model.predictor import predict

HARD_COST_FLOOR = 400.0
DETERMINISTIC_MIN_OCCURRENCES = 3
DETERMINISTIC_MIN_ACCEPTANCES = 1


def _identity_from_state(state: AgentState) -> tuple[str, str | None]:
    user_id = state.get("user_id") or os.getenv("TOKENLENS_USER_ID", "local-user")
    user_id = user_id.strip()
    if not user_id:
        raise ValueError("user_id must be non-empty")

    if "project" in state:
        project = state["project"]
    else:
        project = os.getenv("TOKENLENS_PROJECT") or None
    if project is not None:
        project = project.strip() or None
    return user_id, project


def _eligible_hit(block_hits: list[BlockHit]) -> BlockHit | None:
    eligible = [
        hit
        for hit in block_hits
        if hit["occurrences"] >= DETERMINISTIC_MIN_OCCURRENCES
        and hit["collapse_accepted"] >= DETERMINISTIC_MIN_ACCEPTANCES
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda hit: hit["token_count"])


def _replace_hit(prompt: str, hit: BlockHit) -> str:
    """Replace a matched recurring block without interpreting its contents."""

    marker = f"[Reuse prior block {hit['block_hash'][:8]}.]"
    lines = prompt.splitlines()
    start = hit["start_line"] - 1
    end = hit["end_line"]
    if 0 <= start < end <= len(lines):
        rewritten = [*lines[:start], marker, *lines[end:]]
        return "\n".join(rewritten)

    # Stub fixtures and imported memories may not retain usable source offsets.
    # An exact replacement is still safe when the normalized block was stored.
    normalized_text = hit["normalized_text"]
    if normalized_text and normalized_text in prompt:
        return prompt.replace(normalized_text, marker, 1)

    # A repository hit should normally satisfy one of the paths above. Keeping
    # the original text is safer than deleting a block we cannot locate.
    return prompt


def _deterministic_candidate(prompt: str, hit: BlockHit) -> CandidateRewrite:
    return {
        "rewrite": _replace_hit(prompt, hit),
        "rationale": (
            "This recurring block has appeared "
            f"{hit['occurrences']} times, and collapsing it was previously accepted."
        ),
        "suggestion_type": "collapse_block",
        "source_block_hashes": [hit["block_hash"]],
    }


def gate(state: AgentState) -> dict[str, Any]:
    """Load context, match blocks, predict cost, and choose a route."""

    prompt = state["prompt"]
    session_id = state["session_id"]
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    if not session_id.strip():
        raise ValueError("session_id must be non-empty")

    user_id, project = _identity_from_state(state)
    ctx, profile = load_context(user_id, session_id, project)
    block_hits = match_blocks(prompt, user_id, project)
    predicted_cost = predict(prompt, ctx)

    personal_floor = profile["cost_quantiles"]["p40"]
    skip_floor = max(HARD_COST_FLOOR, personal_floor)
    deterministic_hit = _eligible_hit(block_hits)

    result: dict[str, Any] = {
        "ctx": ctx,
        "profile": profile,
        "block_hits": block_hits,
        "predicted_cost": predicted_cost,
        # A checkpoint carries working memory across turns. Clear only
        # turn-local products so a cheap/failed new draft can never surface a
        # previous turn's candidates or send stale suggestions.
        "candidate_rewrites": [],
        "scored_rewrites": [],
        "suggestions": [],
        "expected_upside": 0.0,
        "reason_model": None,
    }
    if predicted_cost["p50"] < skip_floor and not state.get("force_suggestions", False):
        result["route"] = "skip"
    elif deterministic_hit is not None:
        result["route"] = "deterministic"
        result["candidate_rewrites"] = [
            _deterministic_candidate(prompt, deterministic_hit)
        ]
    else:
        result["route"] = "full"
    return result
