"""Compile the optimization graph with an optional dependency-free fallback."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any, Literal, Protocol, cast

from agent.nodes import gate, package, reason, rescore, retrieve
from agent.state import AgentState
from config import stub_enabled

StreamMode = Literal["updates", "values"]


class CompiledAgentGraph(Protocol):
    """Graph surface consumed by the CLI, service, scripts, and MCP adapter."""

    def invoke(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
    ) -> AgentState: ...

    async def ainvoke(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
    ) -> AgentState: ...

    def astream(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
        *,
        stream_mode: StreamMode = "updates",
    ) -> AsyncIterator[dict[str, Any]]: ...


def invocation_config(session_id: str) -> dict[str, dict[str, str]]:
    """Build the mandatory MongoDBSaver thread configuration."""

    if not session_id.strip():
        raise ValueError("session_id must be non-empty")
    return {"configurable": {"thread_id": session_id}}


def _validate_invocation(
    state: Mapping[str, Any],
    config: Mapping[str, Any] | None,
) -> None:
    prompt = state.get("prompt")
    session_id = state.get("session_id")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be non-empty")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id must be non-empty")
    if config is None:
        raise ValueError("configurable.thread_id is required")
    configurable = config.get("configurable")
    thread_id = (
        configurable.get("thread_id")
        if isinstance(configurable, Mapping)
        else None
    )
    if thread_id != session_id:
        raise ValueError("configurable.thread_id must match state.session_id")


def _route_steps(route: str) -> tuple[tuple[str, Any], ...]:
    if route == "skip":
        return (("package", package),)
    if route == "deterministic":
        return (("rescore", rescore), ("package", package))
    if route == "full":
        return (
            ("retrieve", retrieve),
            ("reason", reason),
            ("rescore", rescore),
            ("package", package),
        )
    raise RuntimeError(f"gate returned unknown route: {route!r}")


class LocalCompiledGraph:
    """Small compiled runner used when LangGraph is not installed.

    It intentionally mirrors LangGraph's ``invoke``, ``ainvoke``, and update
    streaming shapes. This keeps stub mode runnable with only the standard
    library while production can use LangGraph and MongoDBSaver unchanged.
    """

    @staticmethod
    def _updates(
        input_state: AgentState,
        config: dict[str, Any] | None,
    ) -> Iterator[tuple[str, dict[str, Any], AgentState]]:
        _validate_invocation(input_state, config)
        state = cast(AgentState, dict(input_state))

        gate_update = gate(state)
        state.update(gate_update)
        yield "gate", gate_update, cast(AgentState, dict(state))

        for node_name, node in _route_steps(state["route"]):
            update = node(state)
            state.update(update)
            yield node_name, update, cast(AgentState, dict(state))

    def invoke(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
    ) -> AgentState:
        final_state = cast(AgentState, dict(input))
        for _, _, updated_state in self._updates(input, config):
            final_state = updated_state
        return final_state

    async def ainvoke(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
    ) -> AgentState:
        final_state = cast(AgentState, dict(input))
        async for value in self.astream(input, config, stream_mode="values"):
            final_state = cast(AgentState, value)
        return final_state

    async def astream(
        self,
        input: AgentState,
        config: dict[str, Any] | None = None,
        *,
        stream_mode: StreamMode = "updates",
    ) -> AsyncIterator[dict[str, Any]]:
        if stream_mode not in ("updates", "values"):
            raise ValueError("stream_mode must be 'updates' or 'values'")
        for node_name, update, state in self._updates(input, config):
            if stream_mode == "updates":
                yield {node_name: update}
            else:
                yield dict(state)


def _mongo_checkpointer() -> Any | None:
    """Build MongoDBSaver only when real mode is fully configured."""

    if stub_enabled() or not os.getenv("MONGODB_URI", "").strip():
        return None
    try:
        from langgraph.checkpoint.mongodb import MongoDBSaver
    except ImportError:
        return None

    # Client ownership remains in db/. The graph only hands the repository's
    # process-wide client to the checkpointer required by LangGraph.
    from db.client import get_client

    client = get_client()
    database_name = os.getenv("MONGODB_DATABASE", "tokenlens").strip() or "tokenlens"
    return MongoDBSaver(
        client,
        db_name=database_name,
        checkpoint_collection_name="checkpoints",
        writes_collection_name="checkpoint_writes",
        # This makes the saver stamp both checkpoints and its pending writes
        # with ``created_at``. db.indexes uses PyMongo's matching default index
        # name so the saver's repeated TTL create is idempotent on Atlas.
        ttl=86_400,
    )


def _langgraph_compiled(checkpointer: Any | None) -> CompiledAgentGraph | None:
    try:
        from langgraph.graph import END, START, StateGraph
    except ImportError:
        return None

    builder = StateGraph(AgentState)
    builder.add_node("gate", gate)
    builder.add_node("retrieve", retrieve)
    builder.add_node("reason", reason)
    builder.add_node("rescore", rescore)
    builder.add_node("package", package)
    builder.add_edge(START, "gate")
    builder.add_conditional_edges(
        "gate",
        lambda state: state["route"],
        {
            "skip": "package",
            "deterministic": "rescore",
            "full": "retrieve",
        },
    )
    builder.add_edge("retrieve", "reason")
    builder.add_edge("reason", "rescore")
    builder.add_edge("rescore", "package")
    builder.add_edge("package", END)
    return cast(
        CompiledAgentGraph,
        builder.compile(checkpointer=checkpointer),
    )


def build_graph(
    *,
    checkpointer: Any | None = None,
    force_local: bool = False,
) -> CompiledAgentGraph:
    """Compile the five-node graph.

    Real deployments use LangGraph whenever it is installed. Stub and minimal
    local environments fall back to ``LocalCompiledGraph``. Passing an explicit
    checkpointer is useful for tests; otherwise MongoDBSaver is attached when
    both its optional dependency and Mongo configuration are available.
    """

    if force_local:
        return LocalCompiledGraph()

    resolved_checkpointer = (
        checkpointer if checkpointer is not None else _mongo_checkpointer()
    )
    compiled = _langgraph_compiled(resolved_checkpointer)
    if compiled is not None and (stub_enabled() or resolved_checkpointer is not None):
        return compiled
    if stub_enabled():
        return LocalCompiledGraph()
    if resolved_checkpointer is None:
        raise RuntimeError(
            "Real mode requires MONGODB_URI and langgraph-checkpoint-mongodb; "
            "refusing to run without persistent checkpoints"
        )
    raise RuntimeError(
        "Real mode requires LangGraph; refusing to use the in-memory graph fallback"
    )
