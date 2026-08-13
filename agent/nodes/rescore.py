"""Rescore node contract; behavior is implemented in Part 3."""

from typing import Any

from agent.state import AgentState


def rescore(state: AgentState) -> dict[str, Any]:
    """Batch-predict candidates using the gate's unchanged context."""

    del state
    raise NotImplementedError("The rescore node is implemented in Part 3 (Agent C)")
