"""Native Claude Code bridge orchestration behind an explicit host port.

There is intentionally no public-hook implementation of ``NativeComposerPort``.
Current hooks cannot truthfully implement the methods below.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from enum import StrEnum
from typing import Any, Protocol, TypedDict

from compatibility import HostDescriptor, require_compatible
from renderer import NativeView, render_state
from state import (
    NativeComposerState,
    NativeTransitionError,
    accept,
    apply_event,
    begin_analysis,
    edit,
    event_matches,
    new_state,
    prepare_send,
    prompt_hash,
    send_failed,
    send_succeeded,
    skip,
)


class EnterDisposition(StrEnum):
    """Every Enter is consumed by the host; release is always explicit."""

    INTERCEPTED = "intercepted"
    RELEASED = "released"


class ReleaseReceipt(TypedDict):
    """Delivery identity returned by the same-session native host."""

    claude_session_id: str
    usage: dict[str, Any] | None


class NativeEventSink(Protocol):
    async def on_enter(self) -> EnterDisposition: ...

    async def on_edit(self, text: str) -> None: ...

    async def on_choice(self, choice: str) -> None: ...


class NativeComposerPort(Protocol):
    """The six-capability surface a supported Claude host must implement."""

    def describe_host(self) -> HostDescriptor: ...

    def bind(self, sink: NativeEventSink) -> None: ...

    async def read_composer(self) -> str: ...

    async def replace_composer(self, text: str) -> None: ...

    async def render(self, view: NativeView) -> None: ...

    async def clear_rendered_analysis(self) -> None: ...

    async def release_prompt(
        self, prompt: str, send_attempt_id: str
    ) -> ReleaseReceipt: ...


class AnalyzerPort(Protocol):
    def __call__(self, request: dict[str, Any]) -> AsyncIterator[dict[str, Any]]: ...


class FeedbackPort(Protocol):
    async def record_decision(
        self,
        analysis_id: str,
        decision: str,
        selected_prompt_hash: str,
    ) -> None: ...

    async def record_send_attempt(
        self,
        analysis_id: str,
        send_attempt_id: str,
        selected_prompt_hash: str,
        claude_session_id: str | None,
    ) -> None: ...

    async def record_send_result(
        self,
        analysis_id: str,
        claude_session_id: str | None,
        usage: dict[str, Any] | None,
        error: str | None,
        *,
        send_attempt_id: str,
    ) -> None: ...


class RepositoryPort(Protocol):
    """The matching synchronous methods exported by ``db.repo``."""

    def record_decision(
        self, analysis_id: str, decision: str, selected_prompt_hash: str | None
    ) -> None: ...

    def record_send_attempt(
        self,
        analysis_id: str,
        send_attempt_id: str,
        selected_prompt_hash: str,
        claude_session_id: str | None,
    ) -> None: ...

    def record_send_result(
        self,
        analysis_id: str,
        claude_session_id: str | None,
        usage: dict[str, Any] | None,
        error: str | None = None,
        *,
        send_attempt_id: str,
    ) -> None: ...


class RepositoryFeedback:
    """Non-blocking adapter over the existing synchronous repository API."""

    def __init__(self, repository: RepositoryPort) -> None:
        self.repository = repository

    async def record_decision(
        self,
        analysis_id: str,
        decision: str,
        selected_prompt_hash: str,
    ) -> None:
        await asyncio.to_thread(
            self.repository.record_decision,
            analysis_id,
            decision,
            selected_prompt_hash,
        )

    async def record_send_attempt(
        self,
        analysis_id: str,
        send_attempt_id: str,
        selected_prompt_hash: str,
        claude_session_id: str | None,
    ) -> None:
        await asyncio.to_thread(
            self.repository.record_send_attempt,
            analysis_id,
            send_attempt_id,
            selected_prompt_hash,
            claude_session_id,
        )

    async def record_send_result(
        self,
        analysis_id: str,
        claude_session_id: str | None,
        usage: dict[str, Any] | None,
        error: str | None,
        *,
        send_attempt_id: str,
    ) -> None:
        await asyncio.to_thread(
            self.repository.record_send_result,
            analysis_id,
            claude_session_id,
            usage,
            error,
            send_attempt_id=send_attempt_id,
        )


class NullFeedback:
    async def record_decision(
        self,
        analysis_id: str,
        decision: str,
        selected_prompt_hash: str,
    ) -> None:
        return None

    async def record_send_attempt(
        self,
        analysis_id: str,
        send_attempt_id: str,
        selected_prompt_hash: str,
        claude_session_id: str | None,
    ) -> None:
        return None

    async def record_send_result(
        self,
        analysis_id: str,
        claude_session_id: str | None,
        usage: dict[str, Any] | None,
        error: str | None,
        *,
        send_attempt_id: str,
    ) -> None:
        return None


class NativeBridge:
    """Own send permission while a supported native host owns the UI/session."""

    def __init__(
        self,
        *,
        host: NativeComposerPort,
        analyzer: AnalyzerPort,
        claude_session_id: str,
        optimization_session_id: str,
        user_id: str,
        project: str | None,
        feedback: FeedbackPort | None = None,
        analysis_id_factory: Callable[[], str] | None = None,
        send_attempt_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.host = host
        self.analyzer = analyzer
        self.feedback = feedback or NullFeedback()
        self.optimization_session_id = optimization_session_id
        self.user_id = user_id
        self.project = project
        self.state: NativeComposerState = new_state(claude_session_id)
        self._analysis_id_factory = analysis_id_factory or (lambda: str(uuid.uuid4()))
        self._send_attempt_id_factory = send_attempt_id_factory or (
            lambda: str(uuid.uuid4())
        )
        self._lock = asyncio.Lock()
        self._analysis_task: asyncio.Task[None] | None = None
        self._released_attempts: set[str] = set()

    async def start(self) -> None:
        """Fail before binding handlers when the host contract is incomplete."""

        require_compatible(self.host)
        self.state = edit(self.state, await self.host.read_composer())
        self.host.bind(self)

    async def on_edit(self, text: str) -> None:
        async with self._lock:
            if text == self.state["draft_text"]:
                return
            task = self._analysis_task
            self._analysis_task = None
            self.state = edit(self.state, text)
            if task is not None and not task.done():
                task.cancel()
            await self.host.clear_rendered_analysis()

    async def on_enter(self) -> EnterDisposition:
        """Consume first/blocked Enters and explicitly release only from ready."""

        async with self._lock:
            phase = self.state["phase"]
            if phase == "draft":
                visible = await self.host.read_composer()
                self.state = edit(self.state, visible)
                self.state = begin_analysis(
                    self.state,
                    analysis_id=self._analysis_id_factory(),
                )
                request = self._analysis_request()
                await self.host.render(render_state(self.state))
                self._analysis_task = asyncio.create_task(
                    self._consume_analysis(request)
                )
                return EnterDisposition.INTERCEPTED
            if phase in ("analyzing", "review", "sending"):
                return EnterDisposition.INTERCEPTED

            visible = await self.host.read_composer()
            try:
                sending = prepare_send(
                    self.state,
                    visible,
                    send_attempt_id=self._send_attempt_id_factory(),
                )
            except NativeTransitionError:
                self.state = edit(self.state, visible)
                await self.host.clear_rendered_analysis()
                return EnterDisposition.INTERCEPTED
            self.state = sending
            analysis_id = sending["analysis_id"]
            attempt_id = sending["send_attempt_id"]
            selected = sending["selected_prompt"]
            selected_hash = sending["selected_prompt_hash"]
            if None in (analysis_id, attempt_id, selected, selected_hash):
                raise NativeTransitionError("sending identity is incomplete")
            if attempt_id in self._released_attempts:
                raise NativeTransitionError("send attempt was already released")
            try:
                await self.feedback.record_send_attempt(
                    analysis_id,
                    attempt_id,
                    selected_hash,
                    sending["claude_session_id"],
                )
            except Exception as exc:
                self.state = send_failed(self.state, str(exc) or type(exc).__name__)
                await self.host.render(render_state(self.state))
                return EnterDisposition.INTERCEPTED
            self._released_attempts.add(attempt_id)

        try:
            receipt = await self.host.release_prompt(selected, attempt_id)
        except Exception as exc:
            error = str(exc) or type(exc).__name__
            async with self._lock:
                self.state = send_failed(self.state, error)
                try:
                    await self.feedback.record_send_result(
                        analysis_id,
                        None,
                        None,
                        error,
                        send_attempt_id=attempt_id,
                    )
                except Exception:
                    # The host reported failure, so a retry still requires an
                    # explicit Enter. Reconciliation can repair persistence.
                    pass
                await self.host.render(render_state(self.state))
            return EnterDisposition.INTERCEPTED

        async with self._lock:
            self.state = send_succeeded(self.state)
            await self.host.clear_rendered_analysis()
        try:
            await self.feedback.record_send_result(
                analysis_id,
                receipt["claude_session_id"],
                receipt.get("usage"),
                None,
                send_attempt_id=attempt_id,
            )
        except Exception:
            # Delivery already succeeded. Never restore ``ready`` or allow a
            # duplicate merely because the terminal persistence write failed.
            pass
        return EnterDisposition.RELEASED

    async def on_choice(self, choice: str) -> None:
        normalized = choice.strip().lower()
        async with self._lock:
            if self.state["phase"] != "review":
                raise NativeTransitionError("a choice is valid only in review")
            if normalized == "s":
                selected_state = skip(self.state)
            elif normalized in {"1", "2", "3"}:
                selected_state = accept(self.state, int(normalized) - 1)
            elif normalized == "e":
                return
            else:
                raise NativeTransitionError("choice must be 1, 2, 3, S, or E")
            selected = selected_state["selected_prompt"]
            selected_hash = selected_state["selected_prompt_hash"]
            analysis_id = selected_state["analysis_id"]
            decision = selected_state["decision"]
            if None in (selected, selected_hash, analysis_id, decision):
                raise NativeTransitionError("ready selection is incomplete")
            await self.host.replace_composer(str(selected))
            live = await self.host.read_composer()
            if live != selected or prompt_hash(live) != selected_hash:
                raise NativeTransitionError("native host did not replace the composer")
            await self.feedback.record_decision(
                str(analysis_id), str(decision), str(selected_hash)
            )
            self.state = selected_state
            await self.host.render(render_state(self.state))

    async def wait_for_analysis(self) -> None:
        task = self._analysis_task
        if task is None:
            return
        try:
            await task
        except asyncio.CancelledError:
            return

    def _analysis_request(self) -> dict[str, Any]:
        original = self.state["original_prompt"]
        analysis_id = self.state["analysis_id"]
        analyzed_hash = self.state["analyzed_prompt_hash"]
        if original is None or analysis_id is None or analyzed_hash is None:
            raise NativeTransitionError("analysis identity is incomplete")
        return {
            "analysis_id": analysis_id,
            "draft_version": self.state["draft_version"],
            "prompt": original,
            "prompt_hash": analyzed_hash,
            "user_id": self.user_id,
            "project": self.project,
            "optimization_session_id": self.optimization_session_id,
        }

    async def _consume_analysis(self, request: dict[str, Any]) -> None:
        try:
            async for event in self.analyzer(request):
                async with self._lock:
                    if not event_matches(self.state, event):
                        continue
                    self.state = apply_event(self.state, event)
                    await self.host.render(render_state(self.state))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with self._lock:
                failed = {
                    "event": "analysis_failed",
                    "analysis_id": request["analysis_id"],
                    "draft_version": request["draft_version"],
                    "prompt_hash": request["prompt_hash"],
                    "error": str(exc) or type(exc).__name__,
                }
                if event_matches(self.state, failed):
                    self.state = apply_event(self.state, failed)
                    await self.host.render(render_state(self.state))
        finally:
            if self._analysis_task is asyncio.current_task():
                self._analysis_task = None
