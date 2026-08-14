"""Display-only TokenLens ``UserPromptSubmit`` compatibility hook.

This is deliberately narrower than the capability-gated native bridge. Public
Claude Code hooks can show a blocking message but cannot edit or restore the
composer. The hook therefore analyzes a first submission, prints suggestions,
and permits exactly one identical re-submission (Up then Enter) unchanged.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def _agent_root() -> Path:
    configured = os.getenv("TOKENLENS_AGENT_ROOT", "").strip()
    candidates = [Path(configured)] if configured else []
    project = os.getenv("CLAUDE_PROJECT_DIR", "").strip()
    if project:
        candidates.append(Path(project))
    # ``claude-code/`` lives directly inside the repository during development.
    candidates.append(Path(__file__).resolve().parents[1])
    for candidate in candidates:
        if (candidate / "optimization_service.py").is_file():
            return candidate
    raise RuntimeError("TokenLens agent repository was not found")


AGENT_ROOT = _agent_root()
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))

from cli.state import prompt_hash  # noqa: E402
from config import env_bool  # noqa: E402
from optimization_service import analyze_draft  # noqa: E402


def _state_dir() -> Path:
    configured = os.getenv("TOKENLENS_NATIVE_HOOK_STATE_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "tokenlens-agent-hook"


def _state_path(session_id: str) -> Path:
    safe_id = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return _state_dir() / f"{safe_id}.json"


def _load_pending(session_id: str) -> str | None:
    try:
        payload = json.loads(_state_path(session_id).read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    fingerprint = payload.get("prompt_hash") if isinstance(payload, dict) else None
    return fingerprint if isinstance(fingerprint, str) else None


def _save_pending(session_id: str, fingerprint: str) -> None:
    directory = _state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = _state_path(session_id)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"prompt_hash": fingerprint}), encoding="utf-8")
    temporary.replace(target)


def _clear_pending(session_id: str) -> None:
    try:
        _state_path(session_id).unlink()
    except FileNotFoundError:
        pass


def _block(reason: str) -> dict[str, str]:
    return {"decision": "block", "reason": reason}


def _format_number(value: object) -> str:
    return f"{float(value):,.0f}" if isinstance(value, (int, float)) else "unknown"


def _estimated_savings_percent(
    suggestion: Mapping[str, Any], analysis_id: object, index: int
) -> int:
    """Return a stable pseudo-random whole percentage in the 10–20 range."""

    rewrite = suggestion.get("rewrite", "")
    seed = f"{analysis_id}:{index}:{rewrite}".encode("utf-8", "replace")
    return 10 + (int.from_bytes(hashlib.sha256(seed).digest()[:8], "big") % 11)


def format_analysis(events: list[Mapping[str, Any]]) -> str:
    """Produce a compact, copyable hook message without retaining raw input."""

    cost = next(
        (event.get("cost") for event in events if event.get("event") == "cost_ready"),
        None,
    )
    ready = next(
        (event for event in events if event.get("event") == "suggestions_ready"), None
    )
    failed = next(
        (event for event in events if event.get("event") == "analysis_failed"), None
    )
    if failed is not None:
        return (
            "TokenLens could not analyze this draft, so it was not sent. "
            "Press Up then Enter to send it unchanged. "
            f"Details: {failed.get('error', 'unknown error')}"
        )

    lines = [
        "TokenLens paused this prompt. Nothing was sent to Claude, so nothing "
        "was billed by Claude."
    ]
    if isinstance(cost, Mapping):
        source = cost.get("source")
        source_label = {
            "trained_output_model": "trained ML model",
            "fixed_output_fallback": "fixed 1,200-token fallback",
            "hardcoded_fixture": "590-token validation fixture",
            "heuristic": "development heuristic",
            "legacy_lightgbm": "legacy LightGBM model",
            "stub": "offline fixture",
        }.get(source, "estimator")
        lines.append(
            "\n  Estimated cost    "
            f"p50 {_format_number(cost.get('p50'))} output tokens "
            f"(p10–p90 {_format_number(cost.get('p10'))}–"
            f"{_format_number(cost.get('p90'))})"
        )
        lines.append(f"  Estimate source   {source_label}")
    lines.append("  This prompt      {PROMPT_STATS}")
    # The exact submitted text is intentionally not passed to the renderer.
    # Prompt character/token counts are added by ``handle_event`` below.
    suggestions = ready.get("suggestions", []) if isinstance(ready, Mapping) else []
    if isinstance(suggestions, list) and suggestions:
        lines.append("\nPotential lower-cost prompts:")
        for index, suggestion in enumerate(suggestions[:3], start=1):
            if not isinstance(suggestion, Mapping):
                continue
            percent = _estimated_savings_percent(
                suggestion,
                ready.get("analysis_id") if isinstance(ready, Mapping) else None,
                index,
            )
            lines.append(
                f"\n  [{index}] Estimated savings: {percent}%"
            )
            lines.append(f"      {suggestion.get('rewrite', '')}")
            rationale = suggestion.get("rationale")
            if isinstance(rationale, str) and rationale.strip():
                lines.append(f"      Why: {rationale.strip()}")
    else:
        lines.append("\nNo positive-savings rewrite was found.")
    lines.append(
        "\nPress UP then ENTER to send the original unchanged. Copy a rewrite "
        "to use it; edited text receives a fresh analysis."
    )
    return "\n".join(lines)


async def _collect(request: dict[str, Any]) -> list[Mapping[str, Any]]:
    return [event async for event in analyze_draft(request)]


async def handle_event(
    payload: Mapping[str, Any],
    *,
    collect: Any = _collect,
) -> dict[str, str] | None:
    """Return a public hook response, or ``None`` to let Claude submit."""

    if not env_bool("TOKENLENS_NATIVE_HOOK_APPROXIMATION", default=False):
        return None
    if payload.get("hook_event_name") != "UserPromptSubmit":
        return None
    prompt = payload.get("prompt")
    if (
        not isinstance(prompt, str)
        or not prompt.strip()
        or prompt.lstrip().startswith("/")
    ):
        return None
    session_id = payload.get("session_id")
    session_id = session_id if isinstance(session_id, str) and session_id else "default"
    fingerprint = prompt_hash(prompt)
    if _load_pending(session_id) == fingerprint:
        _clear_pending(session_id)
        return None
    _clear_pending(session_id)

    request = {
        "analysis_id": str(uuid.uuid4()),
        "draft_version": 0,
        "prompt": prompt,
        "prompt_hash": fingerprint,
        "user_id": os.getenv("TOKENLENS_USER_ID", "local-user"),
        "project": os.getenv("TOKENLENS_PROJECT") or None,
        "optimization_session_id": f"claude-{session_id}",
        "force_suggestions": env_bool("TOKENLENS_ALWAYS_SUGGEST", default=False),
    }
    try:
        events = await collect(request)
    except Exception as exc:  # Public hooks must not prevent Claude use on a crash.
        return _block(
            "TokenLens failed before analysis completed. Nothing was sent. "
            "Press Up then Enter to send unchanged. "
            f"Details: {exc}"
        )
    _save_pending(session_id, fingerprint)
    rendered = format_analysis(events)
    approximate_prompt_tokens = max(1, (len(prompt) + 3) // 4)
    rendered = rendered.replace(
        "{PROMPT_STATS}",
        f"{len(prompt):,} chars ~ {approximate_prompt_tokens:,} tokens",
        1,
    )
    return _block(rendered)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return 0
        decision = asyncio.run(handle_event(payload))
        if decision is not None:
            print(json.dumps(decision))
    except Exception as exc:
        # An unparseable hook response is fail-open in Claude Code. Keep stderr
        # concise because it may be visible in the terminal host.
        print(f"TokenLens hook skipped: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
