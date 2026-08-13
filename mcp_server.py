"""MCP tool-surface contracts.

FastMCP registration and graph invocation intentionally start in Part 3
(Agent D). Keeping these plain functions importable locks the public schemas
without introducing server behavior early.
"""

from contracts import OptimizePromptResponse, RecordOutcomeResponse


def optimize_prompt(
    prompt: str,
    session_id: str | None = None,
) -> OptimizePromptResponse:
    """Estimate and reduce a long or context-heavy prompt's token cost."""

    del prompt, session_id
    raise NotImplementedError("The MCP adapter is implemented in Part 3 (Agent D)")


def record_outcome(
    suggestion_id: str,
    accepted: bool,
    final_prompt: str | None = None,
) -> RecordOutcomeResponse:
    """Record whether a user accepted, edited, or ignored a rewrite."""

    del suggestion_id, accepted, final_prompt
    raise NotImplementedError("The MCP adapter is implemented in Part 3 (Agent D)")


def main() -> None:
    raise NotImplementedError("The MCP server is implemented in Part 3 (Agent D)")


if __name__ == "__main__":
    main()
