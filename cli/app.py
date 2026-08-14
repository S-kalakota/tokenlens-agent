"""Terminal composer and testable pre-send controller."""

import argparse
import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from cli.claude_client import ClaudeClient, ClaudeResult
from cli.renderer import Renderer
from cli.state import (
    ComposerState,
    accept_suggestion,
    apply_analysis_event,
    begin_analysis,
    edit_draft,
    event_matches,
    new_composer_state,
    prepare_send,
    send_failed,
    send_succeeded,
    skip_optimization,
)
from contracts import AnalysisEvent, AnalysisFailed, AnalyzeDraftRequest
from db import repo as default_repo
from optimization_service import analyze_draft


class Optimizer(Protocol):
    def __call__(
        self,
        request: AnalyzeDraftRequest,
    ) -> AsyncIterator[AnalysisEvent]: ...


EventCallback = Callable[[AnalysisEvent], Awaitable[None] | None]


class ComposerController:
    """Own the sole code path from an editable prompt to ``ClaudeClient.send``."""

    def __init__(
        self,
        *,
        claude_client: ClaudeClient,
        optimizer: Optimizer = analyze_draft,
        repository: Any = default_repo,
        user_id: str = "local-user",
        project: str | None = None,
        optimization_session_id: str | None = None,
        analysis_timeout: float | None = 30.0,
        send_timeout: float | None = None,
    ) -> None:
        self.state = new_composer_state()
        self.claude_client = claude_client
        self.optimizer = optimizer
        self.repository = repository
        self.user_id = user_id
        self.project = project
        self.optimization_session_id = optimization_session_id or str(uuid.uuid4())
        self.analysis_timeout = analysis_timeout
        self.send_timeout = send_timeout
        self._analysis_task: asyncio.Task[None] | None = None
        self._transition_lock = asyncio.Lock()
        self.last_persistence_error: str | None = None

    def edit(self, text: str) -> None:
        """Synchronously invalidate readiness before canceling stale work."""

        old_state = self.state
        self.state = edit_draft(old_state, text)
        if old_state["analysis_id"] and old_state["phase"] in {
            "analyzing",
            "review",
            "ready",
        }:
            try:
                self.repository.record_decision(
                    old_state["analysis_id"], "edited", None
                )
            except Exception:
                # An edit must revoke send permission even during a DB outage.
                pass
        if self._analysis_task and not self._analysis_task.done():
            self._analysis_task.cancel()

    async def enter(
        self,
        *,
        on_analysis_event: EventCallback | None = None,
        on_claude_event: Callable[[dict[str, Any]], Any] | None = None,
    ) -> str:
        """Interpret Enter by phase and return the resulting action name."""

        request: AnalyzeDraftRequest | None = None
        send_snapshot: ComposerState | None = None
        async with self._transition_lock:
            if self.state["phase"] == "draft":
                self.state = begin_analysis(self.state)
                request = self._request_from_state()
                self._analysis_task = asyncio.create_task(
                    self._consume_analysis(request, on_analysis_event)
                )
            elif self.state["phase"] == "ready":
                self.state = prepare_send(self.state)
                send_snapshot = self.state
            else:
                # Enter while analyzing/review/sending is intentionally inert.
                return self.state["phase"]

        if request is not None:
            return "analyzing"
        assert send_snapshot is not None
        await self._send(send_snapshot, on_claude_event)
        return "sent" if self.state["phase"] == "draft" else "send_failed"

    async def wait_for_analysis(self) -> None:
        task = self._analysis_task
        if task is None:
            return
        try:
            await task
        except asyncio.CancelledError:
            return

    async def choose(self, choice: int | str) -> None:
        """Apply Accept 1/2/3 or Skip and persist the explicit decision."""

        async with self._transition_lock:
            current = self.state
            if isinstance(choice, str) and choice.strip().lower() == "s":
                next_state = skip_optimization(current)
            else:
                index = int(choice) - 1
                next_state = accept_suggestion(current, index)
            assert next_state["analysis_id"] is not None
            self.repository.record_decision(
                next_state["analysis_id"],
                next_state["decision"],
                next_state["selected_prompt_hash"],
            )
            self.state = next_state

    async def _consume_analysis(
        self,
        request: AnalyzeDraftRequest,
        callback: EventCallback | None,
    ) -> None:
        try:
            events = self.optimizer(request)
            iterator = events.__aiter__()
            started_at = asyncio.get_running_loop().time()
            while True:
                try:
                    if self.analysis_timeout is None:
                        event = await anext(iterator)
                    else:
                        elapsed = asyncio.get_running_loop().time() - started_at
                        remaining = self.analysis_timeout - elapsed
                        if remaining <= 0:
                            raise TimeoutError("prompt analysis timed out")
                        event = await asyncio.wait_for(anext(iterator), remaining)
                except StopAsyncIteration:
                    break
                current = event_matches(self.state, event)
                self.state = apply_analysis_event(self.state, event)
                if current and callback is not None:
                    result = callback(event)
                    if asyncio.iscoroutine(result):
                        await result
        except asyncio.CancelledError:
            try:
                self.repository.record_decision(
                    request["analysis_id"], "edited", None
                )
            except Exception:
                pass
            raise
        except Exception as exc:
            try:
                self.repository.record_decision(
                    request["analysis_id"], "failed", None
                )
            except Exception:
                pass
            failed: AnalysisFailed = {
                "event": "analysis_failed",
                "analysis_id": request["analysis_id"],
                "draft_version": request["draft_version"],
                "prompt_hash": request["prompt_hash"],
                "error": str(exc) or type(exc).__name__,
            }
            self.state = apply_analysis_event(self.state, failed)
            if callback is not None:
                result = callback(failed)
                if asyncio.iscoroutine(result):
                    await result

    def _request_from_state(self) -> AnalyzeDraftRequest:
        analysis_id = self.state["analysis_id"]
        analyzed_hash = self.state["analyzed_prompt_hash"]
        original = self.state["original_prompt"]
        assert analysis_id and analyzed_hash and original is not None
        return {
            "analysis_id": analysis_id,
            "draft_version": self.state["draft_version"],
            "prompt": original,
            "prompt_hash": analyzed_hash,
            "user_id": self.user_id,
            "project": self.project,
            "optimization_session_id": self.optimization_session_id,
        }

    async def _send(
        self,
        send_snapshot: ComposerState,
        on_claude_event: Callable[[dict[str, Any]], Any] | None,
    ) -> None:
        selected = send_snapshot["selected_prompt"]
        analysis_id = send_snapshot["analysis_id"]
        selected_hash = send_snapshot["selected_prompt_hash"]
        send_attempt_id = send_snapshot["send_attempt_id"]
        assert (
            selected is not None
            and selected_hash is not None
            and analysis_id is not None
            and send_attempt_id is not None
        )

        # This write is the durable boundary between explicit approval and an
        # ambiguous external delivery. If it fails, Claude must not start.
        try:
            self.repository.record_send_attempt(
                analysis_id,
                send_attempt_id,
                selected_hash,
                send_snapshot["claude_session_id"],
            )
        except Exception as exc:
            error = str(exc) or type(exc).__name__
            self.last_persistence_error = error
            async with self._transition_lock:
                if self.state["phase"] == "sending":
                    self.state = send_failed(self.state, error)
            return

        try:
            send = self.claude_client.send(
                selected,
                send_snapshot["claude_session_id"],
                on_event=on_claude_event,
            )
            if self.send_timeout is None:
                result = await send
            else:
                result = await asyncio.wait_for(send, self.send_timeout)
        except Exception as exc:
            try:
                self.repository.record_send_result(
                    analysis_id,
                    send_snapshot["claude_session_id"],
                    None,
                    error=str(exc),
                    send_attempt_id=send_attempt_id,
                )
            except Exception as persistence_exc:
                self.last_persistence_error = (
                    str(persistence_exc) or type(persistence_exc).__name__
                )
            finally:
                async with self._transition_lock:
                    if self.state["phase"] == "sending":
                        self.state = send_failed(self.state, str(exc))
            return

        try:
            self._record_success(send_snapshot, result)
        except Exception as exc:
            # Claude already completed. Never leave the composer in a retryable
            # ready/sending state merely because feedback persistence failed.
            self.last_persistence_error = str(exc) or type(exc).__name__
        async with self._transition_lock:
            if self.state["phase"] == "sending":
                self.state = send_succeeded(self.state, result["session_id"])

    def _record_success(
        self,
        send_snapshot: ComposerState,
        result: ClaudeResult,
    ) -> None:
        analysis_id = send_snapshot["analysis_id"]
        send_attempt_id = send_snapshot["send_attempt_id"]
        assert analysis_id is not None and send_attempt_id is not None
        self.repository.record_send_result(
            analysis_id,
            result["session_id"],
            result["usage"],
            error=None,
            send_attempt_id=send_attempt_id,
        )
        suggestions = send_snapshot["suggestions"]
        predicted_cost = send_snapshot["original_cost"]
        if send_snapshot["decision"] == "accepted":
            predicted_cost = next(
                (
                    suggestion["predicted_cost"]
                    for suggestion in suggestions
                    if suggestion["rewrite"] == send_snapshot["selected_prompt"]
                ),
                predicted_cost,
            )
        if predicted_cost is None:
            raise RuntimeError("sent prompt has no frozen cost prediction")
        ctx, _ = self.repository.load_context(
            self.user_id,
            self.optimization_session_id,
            self.project,
        )
        actual_cost = _usage_token_total(result["usage"])
        self.repository.log_session(
            send_snapshot["selected_prompt"] or "",
            predicted_cost,
            ctx,
            actual_cost=actual_cost,
            claude_session_id=result["session_id"],
            usage=result["usage"],
            analysis_id=analysis_id,
        )
        if send_snapshot["decision"] == "accepted":
            selected = send_snapshot["selected_prompt"]
            for suggestion in suggestions:
                suggestion_id = suggestion.get("suggestion_id")
                if not suggestion_id:
                    continue
                chosen = suggestion["rewrite"] == selected
                actual_savings = None
                if chosen and actual_cost is not None:
                    original_cost = send_snapshot["original_cost"]
                    if original_cost is not None:
                        actual_savings = original_cost["p50"] - actual_cost
                self.repository.record_outcome(
                    suggestion_id,
                    chosen,
                    actual_savings,
                    final_prompt=selected if chosen else None,
                )
        elif send_snapshot["decision"] == "skipped":
            for suggestion in suggestions:
                suggestion_id = suggestion.get("suggestion_id")
                if suggestion_id:
                    self.repository.record_outcome(
                        suggestion_id,
                        False,
                        None,
                        final_prompt=send_snapshot["selected_prompt"],
                    )


def _usage_token_total(usage: dict[str, Any] | None) -> float | None:
    if not usage:
        return None
    total = usage.get("total_tokens")
    if isinstance(total, (int, float)) and not isinstance(total, bool):
        return float(total)
    keys = (
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    )
    values = [usage.get(key) for key in keys]
    numeric = [
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    return sum(numeric) if numeric else None


async def _interactive(args: argparse.Namespace) -> int:
    renderer = Renderer()
    controller = ComposerController(
        claude_client=ClaudeClient(
            cwd=args.cwd,
            executable=args.claude,
            gate_plugin=(
                os.getenv(
                    "TOKENLENS_CLAUDE_GATE_PLUGIN",
                    "tokenlens@tokenlens",
                ).strip()
                or None
            ),
        ),
        user_id=args.user_id,
        project=args.project,
    )

    async def analysis_event(event: AnalysisEvent) -> None:
        if event["event"] == "cost_ready":
            renderer.cost_ready(event["cost"])
        elif event["event"] == "suggestions_ready":
            renderer.suggestions(
                event["suggestions"], controller.state["original_cost"]
            )
        else:
            renderer.error(event["error"])

    while True:
        phase = controller.state["phase"]
        try:
            if phase == "draft":
                text = await asyncio.to_thread(
                    _prompt_multiline,
                    controller.state["draft_text"],
                )
                controller.edit(text)
                await controller.enter(on_analysis_event=analysis_event)
                await controller.wait_for_analysis()
                continue

            if phase == "review":
                choice = await asyncio.to_thread(
                    input,
                    "Choice (1/2/3/S, E to edit): ",
                )
                if choice.strip().lower() == "e":
                    controller.edit(controller.state["draft_text"])
                    continue
                try:
                    await controller.choose(choice)
                except (ValueError, RuntimeError) as exc:
                    renderer.error(str(exc))
                    continue
                renderer.ready(
                    optimized=controller.state["decision"] == "accepted",
                    selected_prompt=controller.state["draft_text"],
                )
                continue

            if phase == "ready":
                replacement = await asyncio.to_thread(
                    input,
                    "Press Enter to send, E for multiline edit, or type replacement: ",
                )
                if replacement.strip().lower() == "e":
                    controller.edit(controller.state["draft_text"])
                    continue
                if replacement:
                    controller.edit(replacement)
                    continue
                outcome = await controller.enter(
                    on_claude_event=renderer.claude_event
                )
                if outcome == "send_failed":
                    renderer.error(
                        controller.state.get("last_error")
                        or "Claude send failed"
                    )
                continue

            # ``enter`` and ``wait_for_analysis`` normally keep these phases
            # internal to the controller. Yield defensively if an alternate
            # optimizer or renderer exposes one to the interactive loop.
            await asyncio.sleep(0)
        except (EOFError, KeyboardInterrupt):
            return 0
        except Exception as exc:
            renderer.error(str(exc))


def _prompt_multiline(initial: str = "") -> str:
    """Enter submits; Ctrl-J inserts a newline when prompt_toolkit is available."""

    try:
        from prompt_toolkit import PromptSession
        from prompt_toolkit.key_binding import KeyBindings
    except ImportError:
        value = input("Draft: ")
        return initial if initial and not value else value

    bindings = KeyBindings()

    @bindings.add("enter")
    def _submit(event: Any) -> None:
        event.current_buffer.validate_and_handle()

    @bindings.add("c-j")
    def _newline(event: Any) -> None:
        event.current_buffer.insert_text("\n")

    session: PromptSession[str] = PromptSession(
        multiline=True,
        key_bindings=bindings,
    )
    return session.prompt(
        "Draft (Ctrl-J for newline, Enter to analyze):\n",
        default=initial,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tokenlens-claude")
    parser.add_argument("--cwd", default=str(Path.cwd()))
    parser.add_argument("--claude", default=os.getenv("CLAUDE_BIN", "claude"))
    parser.add_argument(
        "--user-id", default=os.getenv("TOKENLENS_USER_ID", "local-user")
    )
    parser.add_argument(
        "--project",
        default=os.getenv("TOKENLENS_PROJECT") or Path.cwd().name,
    )
    return parser


def main() -> None:
    raise SystemExit(asyncio.run(_interactive(build_parser().parse_args())))


if __name__ == "__main__":
    main()
