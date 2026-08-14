"""Optional MCP diagnostics adapter over the in-process optimization service."""

import asyncio
import os
import uuid
from typing import Any, cast

from cli.state import prompt_hash
from config import load_environment
from contracts import (
    AnalyzeDraftRequest,
    OptimizePromptResponse,
    PackagedSuggestion,
    RecordOutcomeResponse,
)
from db import repo
from optimization_service import analyze_draft


async def optimize_prompt_async(
    prompt: str,
    session_id: str | None = None,
) -> OptimizePromptResponse:
    """Estimate a prompt and return up to three quantitatively scored rewrites."""

    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    analysis_id = str(uuid.uuid4())
    optimization_session_id = session_id or str(uuid.uuid4())
    request: AnalyzeDraftRequest = {
        "analysis_id": analysis_id,
        "draft_version": 1,
        "prompt": prompt,
        "prompt_hash": prompt_hash(prompt),
        "user_id": os.getenv("TOKENLENS_USER_ID", "mcp-user"),
        "project": os.getenv("TOKENLENS_PROJECT") or None,
        "optimization_session_id": optimization_session_id,
    }
    original_cost = None
    suggestions: list[PackagedSuggestion] = []
    async for event in analyze_draft(request):
        if event["event"] == "cost_ready":
            original_cost = event["cost"]
        elif event["event"] == "suggestions_ready":
            suggestions = [
                cast(
                    PackagedSuggestion,
                    {
                        "suggestion_id": item.get("suggestion_id"),
                        "rewrite": item["rewrite"],
                        "estimated_savings": item["estimated_savings"],
                        "rationale": item["rationale"],
                        "suggestion_type": item["suggestion_type"],
                        "predicted_cost": item["predicted_cost"],
                    },
                )
                for item in event["suggestions"]
            ]
        else:
            raise RuntimeError(event["error"])
    if original_cost is None:
        raise RuntimeError("analysis completed without an original cost")
    return {
        "analysis_id": analysis_id,
        "prompt_hash": request["prompt_hash"],
        "suggestions": suggestions,
        "original_predicted_cost": original_cost,
    }


def optimize_prompt(
    prompt: str,
    session_id: str | None = None,
) -> OptimizePromptResponse:
    """Synchronous convenience surface used by local diagnostics and tests."""

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(optimize_prompt_async(prompt, session_id))
    raise RuntimeError("use optimize_prompt_async from an async application")


def record_outcome(
    suggestion_id: str,
    accepted: bool,
    final_prompt: str | None = None,
) -> RecordOutcomeResponse:
    """Record explicit feedback for a prompt that bypassed pre-send gating."""

    repo.record_outcome(
        suggestion_id,
        accepted,
        None,
        final_prompt=final_prompt,
    )
    return {"ok": True}


def build_mcp_server() -> Any:
    """Build the high-level MCP server lazily.

    MCP 2.x renamed ``FastMCP`` to ``MCPServer``. Supporting both keeps the
    committed stdio adapter usable across the SDK transition without changing
    its two-tool protocol.
    """

    try:
        from mcp.server import MCPServer

        server = MCPServer(
            "TokenLens",
            instructions=(
                "Explicit prompt-cost diagnostics. A compatible native composer "
                "bridge, not MCP, is authoritative for pre-send approval."
            ),
        )
    except ImportError:
        try:
            from mcp.server.fastmcp import FastMCP
        except ImportError as exc:
            raise RuntimeError(
                "The MCP server requires the 'mcp[cli]' package; install the "
                "project's MCP dependency."
            ) from exc
        server = FastMCP("TokenLens", json_response=True)
    server.tool(name="optimize_prompt")(optimize_prompt_async)
    server.tool(name="record_outcome")(record_outcome)
    return server


def main() -> None:
    load_environment()
    build_mcp_server().run(transport="stdio")


if __name__ == "__main__":
    main()
