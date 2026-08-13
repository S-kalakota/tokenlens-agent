"""Gate node contract; behavior is implemented in Part 3."""

from typing import Any

from agent.state import AgentState


def gate(state: AgentState) -> dict[str, Any]:
    """Load context, match blocks, predict cost, and choose a route."""

    del state
    raise NotImplementedError("The gate node is implemented in Part 3 (Agent C)")
