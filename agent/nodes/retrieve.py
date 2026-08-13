"""Retrieve node contract; behavior is implemented in Part 3."""

from typing import Any

from agent.state import AgentState


def retrieve(state: AgentState) -> dict[str, Any]:
    """Retrieve accepted examples and determine allowed suggestion types."""

    del state
    raise NotImplementedError("The retrieve node is implemented in Part 3 (Agent C)")
