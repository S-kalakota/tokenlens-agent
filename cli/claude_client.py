"""Safe Claude Code print-mode handoff.

The wrapper is the only module allowed to construct a Claude subprocess.  It
uses an argv array (never a shell), keeps a fixed working directory, and does
not retry transport failures because delivery may be ambiguous.
"""

import asyncio
import inspect
import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypedDict


class ClaudeResult(TypedDict):
    session_id: str | None
    result: str
    usage: dict[str, Any] | None
    events: list[dict[str, Any]]


StreamCallback = Callable[[dict[str, Any]], Awaitable[None] | None]
DEFAULT_GATE_PLUGIN = "tokenlens@tokenlens"


class ClaudeSendError(RuntimeError):
    """A launch or stream failure that must be retried explicitly by the user."""

    def __init__(self, message: str, *, returncode: int | None = None) -> None:
        super().__init__(message)
        self.returncode = returncode


class ClaudeClient:
    def __init__(
        self,
        *,
        cwd: str | Path,
        executable: str = "claude",
        gate_plugin: str | None = DEFAULT_GATE_PLUGIN,
    ) -> None:
        self.cwd = Path(cwd).resolve()
        self.executable = executable
        self.gate_plugin = gate_plugin.strip() if gate_plugin else None
        if not self.cwd.is_dir():
            raise ValueError(f"Claude working directory does not exist: {self.cwd}")

    def command(self, prompt: str, session_id: str | None = None) -> list[str]:
        if not prompt.strip():
            raise ValueError("prompt must be non-empty")
        argv = [self.executable]
        if self.gate_plugin is not None:
            # This targeted, process-scoped settings override prevents the
            # separately installed TokenLens UserPromptSubmit gate from
            # intercepting a prompt this wrapper already analyzed and approved.
            # Omitted settings still load normally, preserving authentication,
            # model choice, CLAUDE.md, session persistence, and other plugins.
            settings = {"enabledPlugins": {self.gate_plugin: False}}
            argv.extend(
                ["--settings", json.dumps(settings, separators=(",", ":"))]
            )
        argv.append("-p")
        if session_id:
            argv.extend(["--resume", session_id])
        argv.extend(
            [
                prompt,
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--include-hook-events",
            ]
        )
        return argv

    async def send(
        self,
        prompt: str,
        session_id: str | None = None,
        *,
        on_event: StreamCallback | None = None,
    ) -> ClaudeResult:
        """Launch Claude exactly once and consume its structured event stream."""

        argv = self.command(prompt, session_id)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self.cwd),
                env={**os.environ, "TOKENLENS_WRAPPER_ACTIVE": "1"},
                # The approved prompt is supplied as one argv element. Never
                # let the wrapper's own stdin (for example a shell heredoc or
                # terminal input still being edited) become extra Claude input.
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, asyncio.SubprocessError) as exc:
            raise ClaudeSendError(f"could not launch Claude: {exc}") from exc

        assert process.stdout is not None
        assert process.stderr is not None
        stderr_task = asyncio.create_task(process.stderr.read())
        events: list[dict[str, Any]] = []
        response_parts: list[str] = []
        captured_session_id = session_id
        usage: dict[str, Any] | None = None
        stream_failure: str | None = None
        saw_result = False

        try:
            async for raw_line in process.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as exc:
                    process.terminate()
                    await process.wait()
                    raise ClaudeSendError(
                        "Claude emitted invalid stream-json output"
                    ) from exc
                if not isinstance(event, dict):
                    continue
                events.append(event)
                event_session = event.get("session_id")
                if isinstance(event_session, str) and event_session:
                    captured_session_id = event_session
                event_usage = event.get("usage")
                if isinstance(event_usage, dict):
                    usage = event_usage
                event_failure = _event_failure(event)
                if event_failure is not None and stream_failure is None:
                    stream_failure = event_failure
                if event.get("type") == "result":
                    saw_result = True
                result_text = event.get("result")
                if isinstance(result_text, str):
                    response_parts = [result_text]
                elif event.get("type") == "assistant":
                    response_parts.extend(_assistant_text(event))
                if on_event is not None:
                    callback_result = on_event(event)
                    if inspect.isawaitable(callback_result):
                        await callback_result
        except BaseException:
            if process.returncode is None:
                process.terminate()
                await process.wait()
            if not stderr_task.done():
                await stderr_task
            raise

        returncode = await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace").strip()
        if returncode != 0:
            detail = stderr or f"Claude exited with status {returncode}"
            raise ClaudeSendError(detail, returncode=returncode)
        if stream_failure is not None:
            # Claude Code can encode a blocked hook or agent-loop error in a
            # final stream event while still exiting zero. Treat that as an
            # undelivered/failed send, never as an empty successful response.
            raise ClaudeSendError(stream_failure)
        if not saw_result:
            raise ClaudeSendError("Claude stream ended without a result event")

        return {
            "session_id": captured_session_id,
            "result": "".join(response_parts),
            "usage": usage,
            "events": events,
        }


def _assistant_text(event: dict[str, Any]) -> list[str]:
    message = event.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = block.get("text")
        if isinstance(text, str):
            parts.append(text)
    return parts


def _event_failure(event: dict[str, Any]) -> str | None:
    """Return a useful error for blocked hooks or failed result messages."""

    event_type = event.get("type")
    subtype = event.get("subtype")

    # With --include-hook-events, command hook output is available directly.
    # UserPromptSubmit can block either with structured decision JSON or exit 2.
    if (
        event_type == "system"
        and subtype == "hook_response"
        and event.get("hook_event") == "UserPromptSubmit"
    ):
        decision = _hook_decision(event)
        if decision is not None:
            return decision

    # Claude also records a normalized informational event when a submitted
    # prompt is prevented. This catches older/current stream variants that do
    # not expose the raw hook response.
    content = event.get("content")
    if (
        event_type == "system"
        and event.get("preventContinuation") is True
        and isinstance(content, str)
        and "UserPromptSubmit operation blocked by hook" in content
    ):
        return content.strip()

    if event_type != "result":
        return None
    terminal_reason = event.get("terminal_reason")
    if terminal_reason == "hook_stopped":
        return "Claude stopped before delivery because a hook blocked the prompt"
    if event.get("is_error") is not True and not (
        isinstance(subtype, str) and subtype.startswith("error_")
    ):
        return None

    errors = event.get("errors")
    if isinstance(errors, list):
        detail = "; ".join(item for item in errors if isinstance(item, str) and item)
        if detail:
            return detail
    result = event.get("result")
    if isinstance(result, str) and result.strip():
        return result.strip()
    return f"Claude returned {subtype or 'an error result'}"


def _hook_decision(event: dict[str, Any]) -> str | None:
    for field in ("stdout", "output"):
        raw = event.get(field)
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("decision") == "block":
            reason = parsed.get("reason")
            if isinstance(reason, str) and reason.strip():
                return reason.strip()
            return "Claude UserPromptSubmit hook blocked the approved prompt"

    if event.get("exit_code") == 2:
        stderr = event.get("stderr")
        if isinstance(stderr, str) and stderr.strip():
            return stderr.strip()
        return "Claude UserPromptSubmit hook blocked the approved prompt"
    return None
