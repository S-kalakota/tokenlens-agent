import asyncio
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "claude-code"
sys.path.insert(0, str(PLUGIN_ROOT))

from compatibility import REQUIRED_CAPABILITIES, HostDescriptor  # noqa: E402
from native_bridge import EnterDisposition, NativeBridge  # noqa: E402
from state import NativeTransitionError  # noqa: E402


def scored(rewrite: str = "optimized prompt") -> dict:
    return {
        "rewrite": rewrite,
        "rationale": "Remove repeated context",
        "suggestion_type": "dedupe",
        "predicted_cost": {"p10": 10.0, "p50": 20.0, "p90": 30.0},
        "estimated_savings": 80.0,
    }


class FakeHost:
    def __init__(self, *, compatible: bool = True) -> None:
        self.composer = "original long prompt"
        self.compatible = compatible
        self.sink = None
        self.views: list[dict] = []
        self.releases: list[tuple[str, str]] = []
        self.clear_count = 0

    def describe_host(self) -> HostDescriptor:
        capabilities = (
            frozenset(REQUIRED_CAPABILITIES) if self.compatible else frozenset()
        )
        return HostDescriptor(
            host_name="Fake native Claude",
            host_version="1",
            adapter_name="test-adapter",
            adapter_version="1",
            api_revision="composer-v1" if self.compatible else None,
            capabilities=capabilities,
        )

    def bind(self, sink) -> None:
        self.sink = sink

    async def read_composer(self) -> str:
        return self.composer

    async def replace_composer(self, text: str) -> None:
        self.composer = text

    async def render(self, view: dict) -> None:
        self.views.append(view)

    async def clear_rendered_analysis(self) -> None:
        self.clear_count += 1

    async def release_prompt(self, prompt: str, send_attempt_id: str) -> None:
        self.releases.append((prompt, send_attempt_id))
        await asyncio.sleep(0)
        return {"claude_session_id": "claude-session", "usage": {"input": 3}}


class FakeFeedback:
    def __init__(self) -> None:
        self.decisions: list[tuple[str, str, str]] = []
        self.attempts: list[tuple[str, str, str]] = []
        self.results: list[tuple[str, str, str | None]] = []

    async def record_decision(self, *args: str) -> None:
        self.decisions.append(args)

    async def record_send_attempt(self, *args: str) -> None:
        self.attempts.append(args)

    async def record_send_result(
        self,
        analysis_id: str,
        claude_session_id: str | None,
        usage: dict | None,
        error: str | None,
        *,
        send_attempt_id: str,
    ) -> None:
        self.results.append((analysis_id, send_attempt_id, error))


async def analyzer(request: dict):
    identity = {
        "analysis_id": request["analysis_id"],
        "draft_version": request["draft_version"],
        "prompt_hash": request["prompt_hash"],
    }
    yield {
        "event": "cost_ready",
        **identity,
        "cost": {"p10": 80.0, "p50": 100.0, "p90": 120.0},
    }
    await asyncio.sleep(0)
    yield {
        "event": "suggestions_ready",
        **identity,
        "suggestions": [scored()],
        "route": "full",
    }


def bridge(host: FakeHost, feedback: FakeFeedback | None = None) -> NativeBridge:
    return NativeBridge(
        host=host,
        analyzer=analyzer,
        feedback=feedback,
        claude_session_id="claude-session",
        optimization_session_id="optimization-session",
        user_id="user",
        project="project",
        analysis_id_factory=lambda: "analysis-1",
        send_attempt_id_factory=lambda: "attempt-1",
    )


@pytest.mark.asyncio
async def test_incompatible_public_surface_fails_before_handlers_bind() -> None:
    host = FakeHost(compatible=False)
    with pytest.raises(RuntimeError, match="native bridge is unavailable"):
        await bridge(host).start()
    assert host.sink is None
    assert host.releases == []


@pytest.mark.asyncio
async def test_first_enter_then_accept_and_second_enter_sends_once() -> None:
    host = FakeHost()
    feedback = FakeFeedback()
    native = bridge(host, feedback)
    await native.start()

    assert await native.on_enter() == EnterDisposition.INTERCEPTED
    assert host.releases == []
    assert await native.on_enter() == EnterDisposition.INTERCEPTED
    assert host.releases == []

    await native.wait_for_analysis()
    assert native.state["phase"] == "review"
    assert [view["kind"] for view in host.views] == [
        "analyzing",
        "cost",
        "review",
    ]

    await native.on_choice("1")
    assert native.state["phase"] == "ready"
    assert host.composer == "optimized prompt"
    assert host.releases == []

    first, racing_second = await asyncio.gather(
        native.on_enter(), native.on_enter()
    )
    assert {first, racing_second} == {
        EnterDisposition.RELEASED,
        EnterDisposition.INTERCEPTED,
    }
    assert host.releases == [("optimized prompt", "attempt-1")]
    assert len(feedback.attempts) == 1
    assert feedback.results == [("analysis-1", "attempt-1", None)]


@pytest.mark.asyncio
async def test_post_release_persistence_failure_is_not_retryable() -> None:
    class ResultFailure(FakeFeedback):
        async def record_send_result(self, *args, **kwargs) -> None:
            raise RuntimeError("database unavailable after delivery")

    host = FakeHost()
    native = bridge(host, ResultFailure())
    await native.start()
    await native.on_enter()
    await native.wait_for_analysis()
    await native.on_choice("1")

    assert await native.on_enter() == EnterDisposition.RELEASED
    assert native.state["phase"] == "draft"
    assert host.releases == [("optimized prompt", "attempt-1")]


@pytest.mark.asyncio
async def test_skip_also_requires_second_enter() -> None:
    host = FakeHost()
    native = bridge(host)
    await native.start()
    await native.on_enter()
    await native.wait_for_analysis()
    await native.on_choice("s")
    assert host.composer == "original long prompt"
    assert host.releases == []
    assert await native.on_enter() == EnterDisposition.RELEASED
    assert host.releases == [("original long prompt", "attempt-1")]


@pytest.mark.asyncio
async def test_edit_revokes_ready_and_next_enter_reanalyzes() -> None:
    host = FakeHost()
    native = bridge(host)
    await native.start()
    await native.on_enter()
    await native.wait_for_analysis()
    await native.on_choice("1")

    host.composer = "optimized prompt edited"
    await native.on_edit(host.composer)
    assert native.state["phase"] == "draft"
    assert native.state["decision"] is None
    assert host.releases == []

    assert await native.on_enter() == EnterDisposition.INTERCEPTED
    assert host.releases == []


@pytest.mark.asyncio
async def test_invalid_choice_never_releases() -> None:
    host = FakeHost()
    native = bridge(host)
    await native.start()
    await native.on_enter()
    await native.wait_for_analysis()
    with pytest.raises(NativeTransitionError, match="choice must"):
        await native.on_choice("4")
    assert host.releases == []
