"""LangGraph boundary reserved for Part 3 of the build plan."""

from typing import Any, Protocol

from agent.state import AgentState


class CompiledAgentGraph(Protocol):
    """The minimal graph surface consumed by scripts and the MCP adapter."""

    def invoke(
        self,
        input: AgentState,
        config: dict[str, Any],
    ) -> AgentState: ...


def invocation_config(session_id: str) -> dict[str, dict[str, str]]:
    """Build the mandatory MongoDBSaver thread configuration."""

    if not session_id.strip():
        raise ValueError("session_id must be non-empty")
    return {"configurable": {"thread_id": session_id}}


def build_graph() -> CompiledAgentGraph:
    """Compile the five-node graph.

    The implementation intentionally belongs to Part 3 (Agent C). Defining the
    boundary here lets the model, data, and MCP layers depend on a stable
    import without prematurely implementing orchestration.
    """

    raise NotImplementedError("LangGraph orchestration starts in Part 3 (Agent C)")
