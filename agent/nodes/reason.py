"""Grounded rewrite generation through fixtures or OpenRouter."""

import json
import math
import os
import statistics
from collections.abc import Sequence
from copy import deepcopy
from typing import Any, cast

from agent.state import AgentState
from config import load_stub_data, stub_enabled
from contracts import BlockHit, CandidateRewrite, RetrievedExample

MAX_CANDIDATES = 3
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_CHEAP_REASON_MODEL = "anthropic/claude-haiku-4.5"
DEFAULT_STRONG_REASON_MODEL = "anthropic/claude-sonnet-4"
# Kept as a compatibility alias for callers that imported the old constant.
DEFAULT_REASON_MODEL = DEFAULT_CHEAP_REASON_MODEL
DEFAULT_REASON_MAX_TOKENS = 1_200
DEFAULT_STRONG_UPSIDE_TOKENS = 400.0
DEFAULT_UNKNOWN_ACCEPTANCE = 0.35


class CandidateResponseError(ValueError):
    """Raised when a model response violates the candidate contract."""


def _acceptance_probability(state: AgentState, suggestion_type: str) -> float:
    profile = state.get("profile")
    if profile is None:
        return DEFAULT_UNKNOWN_ACCEPTANCE
    stats = profile["accept_rate_by_type"].get(suggestion_type)
    if stats is None:
        return DEFAULT_UNKNOWN_ACCEPTANCE
    return min(1.0, max(0.0, float(stats["rate"])))


def expected_upside_tokens(state: AgentState) -> float:
    """Estimate expected accepted savings from memory and prompt cost shape.

    Similar accepted outcomes are the most prompt-shape-specific signal. The
    cost-gap fallback keeps cold-start routing useful: it measures how far the
    current prompt sits above this user's learned p40 and discounts that gap by
    the best acceptance probability still allowed by retrieval.
    """

    predicted_cost = state.get("predicted_cost")
    if not predicted_cost:
        raise ValueError("reason requires predicted_cost")
    allowed_types = state.get("allowed_types", [])
    if not allowed_types:
        raise ValueError("reason requires allowed_types")

    probabilities = {
        suggestion_type: _acceptance_probability(state, suggestion_type)
        for suggestion_type in allowed_types
    }
    best_probability = max(probabilities.values(), default=DEFAULT_UNKNOWN_ACCEPTANCE)
    profile = state.get("profile")
    personal_floor = (
        float(profile["cost_quantiles"]["p40"]) if profile is not None else 400.0
    )
    cost_shape_value = max(
        0.0, float(predicted_cost["p50"]) - max(400.0, personal_floor)
    ) * best_probability

    allowed = set(allowed_types)
    similar_values = [
        float(example["actual_savings"])
        * probabilities.get(example["suggestion_type"], DEFAULT_UNKNOWN_ACCEPTANCE)
        for example in state.get("retrieved_examples", [])
        if example["suggestion_type"] in allowed
        and float(example["actual_savings"]) > 0
    ]
    memory_value = (
        float(statistics.median(similar_values)) if similar_values else 0.0
    )
    return max(cost_shape_value, memory_value)


def _configured_model(name: str, default: str) -> str:
    model = os.getenv(name, default).strip()
    if not model:
        raise ValueError(f"{name} must be non-empty")
    return model


def _strong_upside_threshold() -> float:
    raw = os.getenv(
        "TOKENLENS_REASON_STRONG_UPSIDE_TOKENS",
        str(DEFAULT_STRONG_UPSIDE_TOKENS),
    )
    try:
        threshold = float(raw)
    except ValueError as exc:
        raise ValueError(
            "TOKENLENS_REASON_STRONG_UPSIDE_TOKENS must be a number"
        ) from exc
    if not math.isfinite(threshold) or threshold < 0:
        raise ValueError(
            "TOKENLENS_REASON_STRONG_UPSIDE_TOKENS must be finite and non-negative"
        )
    return threshold


def select_reason_model(state: AgentState) -> tuple[str, float]:
    """Choose the cheap or strong model from deterministic expected upside."""

    expected_upside = expected_upside_tokens(state)
    fixed_override = (
        os.getenv("TOKENLENS_REASON_MODEL", "").strip()
        or os.getenv("OPENROUTER_MODEL", "").strip()
    )
    if fixed_override:
        return fixed_override, expected_upside
    cheap_model = _configured_model(
        "TOKENLENS_REASON_CHEAP_MODEL", DEFAULT_CHEAP_REASON_MODEL
    )
    strong_model = _configured_model(
        "TOKENLENS_REASON_STRONG_MODEL", DEFAULT_STRONG_REASON_MODEL
    )
    selected = (
        strong_model
        if expected_upside >= _strong_upside_threshold()
        else cheap_model
    )
    return selected, expected_upside


def _normalize_text(text: str) -> str:
    return " ".join(text.split())


def _collapse_source_hashes(
    prompt: str,
    rewrite: str,
    block_hits: Sequence[BlockHit],
) -> list[str]:
    """Identify one current block that a genuine collapse rewrite removed."""

    normalized_prompt = _normalize_text(prompt)
    normalized_rewrite = _normalize_text(rewrite)
    if normalized_rewrite == normalized_prompt:
        return []

    matching_hits = [
        hit
        for hit in block_hits
        if hit["normalized_text"]
        and hit["normalized_text"] in normalized_prompt
    ]
    removed_hits = [
        hit
        for hit in matching_hits
        if hit["normalized_text"] not in normalized_rewrite
    ]
    # A changed rewrite is not enough to attribute feedback to a block: it may
    # have edited unrelated prose while retaining every recurring block. Only
    # provenance we can verify as absent from the rewrite is safe to learn from.
    if not removed_hits:
        return []
    selected = max(removed_hits, key=lambda hit: hit["token_count"])
    return [selected["block_hash"]]


def _candidate_with_provenance(
    state: AgentState,
    candidate: CandidateRewrite,
) -> CandidateRewrite:
    annotated = dict(candidate)
    # Model adapters are not trusted to assign database provenance. It is
    # derived from the current graph state only, and non-collapse rewrites can
    # never increment recurring-block acceptance.
    annotated.pop("source_block_hashes", None)
    if candidate["suggestion_type"] == "collapse_block":
        source_hashes = _collapse_source_hashes(
            state["prompt"],
            candidate["rewrite"],
            state.get("block_hits", []),
        )
        if source_hashes:
            annotated["source_block_hashes"] = source_hashes
    return cast(CandidateRewrite, annotated)


def _stub_candidates(allowed_types: Sequence[str]) -> list[CandidateRewrite]:
    allowed = set(allowed_types)
    candidates = cast(
        list[CandidateRewrite],
        deepcopy(load_stub_data()["candidate_rewrites"]),
    )
    return [
        candidate
        for candidate in candidates
        if candidate["suggestion_type"] in allowed
    ][:MAX_CANDIDATES]


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        if parts:
            return "".join(parts)
    raise CandidateResponseError("reasoning model returned non-text content")


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) < 3 or not lines[-1].strip().startswith("```"):
        return stripped
    return "\n".join(lines[1:-1]).strip()


def _schema_items(payload: Any) -> list[dict[str, Any]]:
    """Validate the response shape with Pydantic when it is installed."""

    try:
        from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError
    except ImportError:
        if not isinstance(payload, list):
            raise CandidateResponseError(
                "candidate response must be a JSON array"
            ) from None
        required = {"rewrite", "rationale", "suggestion_type"}
        for item in payload:
            if not isinstance(item, dict):
                raise CandidateResponseError(
                    "each candidate must be a JSON object"
                ) from None
            if set(item) != required:
                raise CandidateResponseError(
                    "candidate fields must be rewrite, rationale, and suggestion_type"
                ) from None
        return payload

    class CandidateModel(BaseModel):
        model_config = ConfigDict(extra="forbid")

        rewrite: str
        rationale: str
        suggestion_type: str

    try:
        validated = TypeAdapter(list[CandidateModel]).validate_python(payload)
    except ValidationError as exc:
        raise CandidateResponseError(
            "candidate response does not match the required schema"
        ) from exc
    return [item.model_dump() for item in validated]


def _validate_candidates(
    raw_response: str,
    allowed_types: Sequence[str],
) -> list[CandidateRewrite]:
    try:
        payload = json.loads(_strip_json_fence(raw_response))
    except json.JSONDecodeError as exc:
        raise CandidateResponseError("reasoning model returned invalid JSON") from exc

    # Some OpenAI-compatible providers require a JSON object at the root. The
    # documented array and the equivalent {"candidates": [...]} envelope are
    # accepted, while every candidate is still validated identically.
    if isinstance(payload, dict) and set(payload) == {"candidates"}:
        payload = payload["candidates"]
    payload = _schema_items(payload)

    allowed = set(allowed_types)
    validated: list[CandidateRewrite] = []
    seen_rewrites: set[str] = set()
    for item in payload:
        rewrite = item["rewrite"]
        rationale = item["rationale"]
        suggestion_type = item["suggestion_type"]
        if not all(isinstance(value, str) and value.strip() for value in (
            rewrite,
            rationale,
            suggestion_type,
        )):
            raise CandidateResponseError("candidate fields must be non-empty strings")

        # The allowed-type constraint is enforced after parsing, independently
        # of whether the model followed the same instruction in its prompt.
        if suggestion_type not in allowed:
            continue
        rewrite = rewrite.strip()
        if rewrite in seen_rewrites:
            continue
        seen_rewrites.add(rewrite)
        validated.append(
            {
                "rewrite": rewrite,
                "rationale": rationale.strip(),
                "suggestion_type": suggestion_type,
            }
        )
        if len(validated) == MAX_CANDIDATES:
            break
    return validated


def _grounding_text(examples: Sequence[RetrievedExample]) -> str:
    if not examples:
        return "No accepted examples are available for this user yet."
    sections = []
    for index, example in enumerate(examples[:3], start=1):
        sections.append(
            f"Example {index}:\n"
            f"Prompt: {example['prompt_excerpt'][:200]}\n"
            f"Accepted rewrite: {example['rewrite'][:200]}\n"
            f"Type: {example['suggestion_type']}\n"
            f"Actual savings: {example['actual_savings']:.0f} tokens"
        )
    return "\n\n".join(sections)


def _invoke_openrouter(
    messages: list[tuple[str, str]],
    *,
    model_name: str | None = None,
) -> str:
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as exc:  # pragma: no cover - exercised in deployments
        raise RuntimeError(
            "langchain-openai is required when TOKENLENS_STUB is disabled"
        ) from exc

    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required outside stub mode")
    resolved_model = model_name or (
        os.getenv("TOKENLENS_REASON_MODEL", "").strip()
        or os.getenv("OPENROUTER_MODEL", "").strip()
        or _configured_model(
            "TOKENLENS_REASON_CHEAP_MODEL", DEFAULT_CHEAP_REASON_MODEL
        )
    )
    raw_max_tokens = os.getenv(
        "TOKENLENS_REASON_MAX_TOKENS", str(DEFAULT_REASON_MAX_TOKENS)
    )
    try:
        max_tokens = int(raw_max_tokens)
    except ValueError as exc:
        raise ValueError("TOKENLENS_REASON_MAX_TOKENS must be an integer") from exc
    if max_tokens <= 0:
        raise ValueError("TOKENLENS_REASON_MAX_TOKENS must be positive")
    model = ChatOpenAI(
        model=resolved_model,
        api_key=api_key,
        base_url=os.getenv("OPENROUTER_BASE_URL", OPENROUTER_BASE_URL),
        temperature=0,
        max_tokens=max_tokens,
        max_retries=0,
    )
    response = model.invoke(messages)
    return _message_text(response.content)


def call_reasoning_model(
    prompt: str,
    retrieved_examples: Sequence[RetrievedExample],
    allowed_types: Sequence[str],
    *,
    model_name: str | None = None,
) -> list[CandidateRewrite]:
    """Return at most three schema-validated, allowed candidate rewrites."""

    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    if not allowed_types:
        raise ValueError("allowed_types must be non-empty")
    if stub_enabled():
        return _stub_candidates(allowed_types)

    system_message = (
        "You reduce prompt token cost without dropping objectives or constraints. "
        "Return only a JSON array with up to three objects. Each object must have "
        "exactly these string fields: rewrite, rationale, suggestion_type. "
        f"Allowed suggestion_type values: {', '.join(allowed_types)}.\n\n"
        "Grounding from this user's accepted, positive-savings history:\n"
        f"{_grounding_text(retrieved_examples)}"
    )
    messages = [
        ("system", system_message),
        ("human", f"Rewrite this prompt:\n\n{prompt}"),
    ]
    last_error: CandidateResponseError | None = None
    for attempt in range(2):
        response = _invoke_openrouter(messages, model_name=model_name)
        try:
            return _validate_candidates(response, allowed_types)
        except CandidateResponseError as exc:
            last_error = exc
            if attempt == 0:
                messages.append(("assistant", response))
                messages.append(
                    (
                        "human",
                        "That response did not match the required JSON candidate "
                        "schema. Return only the corrected JSON array.",
                    )
                )
    raise CandidateResponseError(
        "reasoning model returned invalid candidates after one retry"
    ) from last_error


def reason(state: AgentState) -> dict[str, Any]:
    """Run the graph's reason node."""

    model_name, expected_upside = select_reason_model(state)
    candidates = call_reasoning_model(
        state["prompt"],
        state.get("retrieved_examples", []),
        state["allowed_types"],
        model_name=model_name,
    )
    # The model boundary also filters, but retaining the check here makes this
    # node safe when tests or alternate model adapters replace that function.
    allowed = set(state["allowed_types"])
    return {
        "expected_upside": expected_upside,
        "reason_model": model_name,
        "candidate_rewrites": [
            _candidate_with_provenance(state, candidate)
            for candidate in candidates
            if candidate["suggestion_type"] in allowed
        ][:MAX_CANDIDATES]
    }
