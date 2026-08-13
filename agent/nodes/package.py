"""Package node contract; behavior is implemented in Part 3."""

from typing import Any

from agent.state import AgentState


def package(state: AgentState) -> dict[str, Any]:
    """Rank scored rewrites by expected value and return the top three."""

    del state
    raise NotImplementedError("The package node is implemented in Part 3 (Agent C)")
