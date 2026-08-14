"""Optimization API shared by pre-send hosts and the MCP adapter."""

import asyncio
from collections.abc import AsyncIterator, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, cast

from agent.graph import build_graph, invocation_config
from agent.state import AgentState
from config import env_bool
from contracts import (
    AnalysisEvent,
    AnalysisFailed,
    AnalyzeDraftRequest,
    CostReady,
    Route,
    ScoredRewrite,
    SuggestionsReady,
)
from db import repo


async def analyze_draft(
    request: AnalyzeDraftRequest,
    *,
    graph: Any | None = None,
    gate_timeout: float | None = None,
    analysis_timeout: float | None = None,
) -> AsyncIterator[AnalysisEvent]:
    """Emit the gate cost first, then the final ranked rewrites.

    Every event repeats the immutable draft identity.  Persistence is part of
    the analysis transaction; failures produce ``analysis_failed`` and never a
    state that a compatible pre-send host can release.
    """

    identity = {
        "analysis_id": request.get("analysis_id", ""),
        "draft_version": request.get("draft_version", -1),
        "prompt_hash": request.get("prompt_hash", ""),
    }
    logged = False
    validated = False
    try:
        _validate_request(request)
        validated = True
        compiled = graph or build_graph()
        initial_state = cast(
            AgentState,
            {
                "prompt": request["prompt"],
                "session_id": request["optimization_session_id"],
                "user_id": request["user_id"],
                "project": request["project"],
                "force_suggestions": request.get("force_suggestions", False),
            },
        )
        merged: dict[str, Any] = dict(initial_state)
        emitted_cost = False

        updates = _graph_updates(
            compiled,
            initial_state,
            invocation_config(request["optimization_session_id"]),
        ).__aiter__()
        started_at = asyncio.get_running_loop().time()
        next_timeout = gate_timeout
        while True:
            if analysis_timeout is not None:
                elapsed = asyncio.get_running_loop().time() - started_at
                remaining = analysis_timeout - elapsed
                if remaining <= 0:
                    raise TimeoutError("prompt analysis timed out")
                next_timeout = (
                    remaining if next_timeout is None else min(next_timeout, remaining)
                )
            try:
                if next_timeout is None:
                    update = await anext(updates)
                else:
                    update = await asyncio.wait_for(anext(updates), next_timeout)
            except StopAsyncIteration:
                break
            except TimeoutError as exc:
                stage = "cost prediction" if not emitted_cost else "prompt analysis"
                raise TimeoutError(f"{stage} timed out") from exc

            merged.update(update)
            cost = merged.get("predicted_cost")
            if not emitted_cost and isinstance(cost, dict):
                event: CostReady = {
                    "event": "cost_ready",
                    **identity,
                    "cost": deepcopy(cost),
                }
                emitted_cost = True
                try:
                    # Let the terminal render before a synchronous Atlas write
                    # can add latency. The finally block still logs the analysis
                    # when a caller cancels immediately after seeing the cost.
                    yield event
                finally:
                    if not logged:
                        _log_analysis(request, cost)
                        logged = True
                next_timeout = None

        cost = merged.get("predicted_cost")
        if not isinstance(cost, dict):
            raise RuntimeError("optimization graph did not produce a cost prediction")
        if not emitted_cost:
            event = {
                "event": "cost_ready",
                **identity,
                "cost": deepcopy(cost),
            }
            try:
                yield cast(CostReady, event)
            finally:
                if not logged:
                    _log_analysis(request, cost)
                    logged = True

        raw_suggestions = merged.get("suggestions", merged.get("scored_rewrites", []))
        if not isinstance(raw_suggestions, list):
            raise RuntimeError("optimization graph returned invalid suggestions")
        suggestions = cast(list[ScoredRewrite], deepcopy(raw_suggestions[:3]))
        suggestion_ids = repo.log_suggestions(
            request["optimization_session_id"],
            suggestions,
            user_id=request["user_id"],
            analysis_id=request["analysis_id"],
            project=request["project"],
        )
        for suggestion, suggestion_id in zip(suggestions, suggestion_ids, strict=False):
            suggestion["suggestion_id"] = suggestion_id
        route = merged.get("route", "full")
        if route not in ("full", "deterministic", "skip"):
            route = "full"
        ready: SuggestionsReady = {
            "event": "suggestions_ready",
            **identity,
            "suggestions": suggestions,
            "route": cast(Route, route),
        }
        yield ready
    except asyncio.CancelledError:
        # The pre-send host records an edit synchronously before it cancels work.
        # Other callers may cancel for shutdown, which is not user feedback.
        raise
    except Exception as exc:
        # A valid first-Enter analysis remains an episodic fact even when the
        # graph fails before producing a cost (for example, an unavailable
        # model). Persist it with a null original cost when MongoDB itself is
        # still reachable, then mark the same immutable analysis failed.
        if validated and not logged:
            try:
                _log_analysis(request, None)
                logged = True
            except Exception:
                # Preserve the original analysis error in the UI. A database
                # outage can make both the graph and this best-effort log fail.
                pass
        if logged:
            _best_effort_decision(request["analysis_id"], "failed", None)
        failed: AnalysisFailed = {
            "event": "analysis_failed",
            **identity,
            "error": str(exc) or type(exc).__name__,
        }
        yield failed


async def collect_analysis(
    request: AnalyzeDraftRequest,
    *,
    graph: Any | None = None,
    gate_timeout: float | None = None,
    analysis_timeout: float | None = None,
) -> list[AnalysisEvent]:
    return [
        event
        async for event in analyze_draft(
            request,
            graph=graph,
            gate_timeout=gate_timeout,
            analysis_timeout=analysis_timeout,
        )
    ]


def _validate_request(request: AnalyzeDraftRequest) -> None:
    from cli.state import prompt_hash

    for field in ("analysis_id", "prompt", "prompt_hash", "user_id"):
        value = request.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field} must be non-empty")
    if request.get("draft_version", -1) < 0:
        raise ValueError("draft_version must be non-negative")
    session_id = request.get("optimization_session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("optimization_session_id must be non-empty")
    if prompt_hash(request["prompt"]) != request["prompt_hash"]:
        raise ValueError("prompt_hash does not match the exact prompt bytes")


def _log_analysis(
    request: AnalyzeDraftRequest,
    cost: Mapping[str, Any] | None,
) -> None:
    now = datetime.now(UTC)
    analysis: dict[str, Any] = {
        "analysis_id": request["analysis_id"],
        "draft_version": request["draft_version"],
        "user_id": request["user_id"],
        "project": request["project"],
        "optimization_session_id": request["optimization_session_id"],
        "original_prompt_hash": request["prompt_hash"],
        "prompt_hash": request["prompt_hash"],
        "prompt": request["prompt"],
        "original_cost": dict(cost) if cost is not None else None,
        "candidate_ids": [],
        "decision": None,
        "selected_prompt_hash": None,
        "claude_session_id": None,
        "created_at": now,
        "updated_at": now,
    }
    if env_bool("TOKENLENS_RETAIN_RAW_PROMPTS", default=False):
        analysis["original_prompt"] = request["prompt"]
    repo.log_draft_analysis(analysis)


def _best_effort_decision(
    analysis_id: str,
    decision: str,
    selected_prompt_hash: str | None,
) -> None:
    try:
        repo.record_decision(analysis_id, decision, selected_prompt_hash)
    except Exception:
        # Preserve the original graph error in the emitted failure event.
        return


async def _graph_updates(
    graph: Any,
    initial_state: AgentState,
    config: dict[str, Any],
) -> AsyncIterator[dict[str, Any]]:
    """Normalize LangGraph and the dependency-free runner's stream shapes."""

    if hasattr(graph, "astream"):
        try:
            stream = graph.astream(initial_state, config, stream_mode="updates")
        except TypeError:
            stream = graph.astream(initial_state, config)
        async for raw_update in stream:
            for update in _normalize_update(raw_update):
                yield update
        return
    if hasattr(graph, "ainvoke"):
        result = await graph.ainvoke(initial_state, config)
    else:
        result = await asyncio.to_thread(graph.invoke, initial_state, config)
    if isinstance(result, Mapping):
        yield dict(result)


def _normalize_update(raw_update: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_update, Mapping):
        return []
    # ``stream_mode=updates`` yields {node_name: partial_state}.
    nested = [value for value in raw_update.values() if isinstance(value, Mapping)]
    if nested and all(key not in raw_update for key in ("prompt", "predicted_cost")):
        return [dict(value) for value in nested]
    return [dict(raw_update)]
