import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from cli.app import ComposerController, _interactive


class FakeRepository:
    def __init__(self, *, fail_send_attempt=False) -> None:
        self.decisions = []
        self.send_attempts = []
        self.send_results = []
        self.outcomes = []
        self.sessions = []
        self.timeline = []
        self.fail_send_attempt = fail_send_attempt

    def record_decision(self, *args):
        self.decisions.append(args)

    def record_send_result(self, *args, **kwargs):
        self.send_results.append((args, kwargs))
        self.timeline.append(("send_result", kwargs["send_attempt_id"]))

    def record_send_attempt(self, *args, **kwargs):
        self.send_attempts.append((args, kwargs))
        self.timeline.append(("send_attempt", args[1]))
        if self.fail_send_attempt:
            raise RuntimeError("could not persist pending send")

    def record_outcome(self, *args, **kwargs):
        self.outcomes.append((args, kwargs))

    def load_context(self, user_id, session_id, project):
        return (
            {
                "user_id": user_id,
                "session_id": session_id,
                "project": project,
                "target_model": "fake-model",
                "session_turn_index": len(self.sessions),
                "recent_costs": [],
                "completion_ratio_median": 0.35,
                "calibration_bias": 0.0,
            },
            {},
        )

    def log_session(self, *args, **kwargs):
        self.sessions.append((args, kwargs))
        return f"session-{len(self.sessions)}"


class FakeClaudeClient:
    def __init__(self, *, fail_first=False, block=False, timeline=None) -> None:
        self.calls = []
        self.fail_first = fail_first
        self.timeline = timeline
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        if not block:
            self.release.set()

    async def send(self, prompt, session_id=None, *, on_event=None):
        self.calls.append((prompt, session_id))
        if self.timeline is not None:
            self.timeline.append(("claude_send", prompt))
        self.started.set()
        await self.release.wait()
        if self.fail_first and len(self.calls) == 1:
            raise RuntimeError("ambiguous transport failure")
        return {
            "session_id": session_id or "claude-session-1",
            "result": "done",
            "usage": {"input_tokens": 10},
            "events": [],
        }


def optimizer(*, pause=None):
    async def run(request):
        yield {
            "event": "cost_ready",
            "analysis_id": request["analysis_id"],
            "draft_version": request["draft_version"],
            "prompt_hash": request["prompt_hash"],
            "cost": {"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
        }
        if pause is not None:
            await pause.wait()
        yield {
            "event": "suggestions_ready",
            "analysis_id": request["analysis_id"],
            "draft_version": request["draft_version"],
            "prompt_hash": request["prompt_hash"],
            "route": "full",
            "suggestions": [
                {
                    "suggestion_id": "suggestion-1",
                    "rewrite": "short prompt",
                    "rationale": "deduplicate it",
                    "suggestion_type": "dedupe",
                    "predicted_cost": {
                        "p10": 300.0,
                        "p50": 400.0,
                        "p90": 500.0,
                    },
                    "estimated_savings": 600.0,
                }
            ],
        }

    return run


class ComposerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def make_controller(self, *, fail_send_attempt=False, **claude_kwargs):
        repository = FakeRepository(fail_send_attempt=fail_send_attempt)
        claude = FakeClaudeClient(timeline=repository.timeline, **claude_kwargs)
        controller = ComposerController(
            claude_client=claude,
            optimizer=optimizer(),
            repository=repository,
        )
        return controller, claude, repository

    async def analyze(self, controller):
        controller.edit("a long original prompt")
        self.assertEqual(await controller.enter(), "analyzing")
        await controller.wait_for_analysis()
        self.assertEqual(controller.state["phase"], "review")

    async def test_first_enter_and_choice_do_not_invoke_claude(self) -> None:
        controller, claude, _ = self.make_controller()

        await self.analyze(controller)
        self.assertEqual(claude.calls, [])
        await controller.choose(1)
        self.assertEqual(controller.state["phase"], "ready")
        self.assertEqual(claude.calls, [])

    async def test_accept_and_skip_both_require_second_enter(self) -> None:
        for choice, expected in ((1, "short prompt"), ("s", "a long original prompt")):
            with self.subTest(choice=choice):
                controller, claude, _ = self.make_controller()
                await self.analyze(controller)
                await controller.choose(choice)

                self.assertEqual(claude.calls, [])
                self.assertEqual(await controller.enter(), "sent")
                self.assertEqual(claude.calls, [(expected, None)])

    async def test_pending_attempt_is_persisted_before_claude_launch(self) -> None:
        controller, _, repository = self.make_controller()
        await self.analyze(controller)
        await controller.choose(1)

        await controller.enter()

        self.assertEqual(
            [event[0] for event in repository.timeline[:3]],
            ["send_attempt", "claude_send", "send_result"],
        )
        pending_id = repository.send_attempts[0][0][1]
        self.assertEqual(
            repository.send_results[0][1]["send_attempt_id"],
            pending_id,
        )

    async def test_pending_persistence_failure_never_launches_claude(self) -> None:
        controller, claude, repository = self.make_controller(
            fail_send_attempt=True
        )
        await self.analyze(controller)
        await controller.choose(1)

        self.assertEqual(await controller.enter(), "send_failed")

        self.assertEqual(claude.calls, [])
        self.assertEqual(repository.send_results, [])
        self.assertEqual(controller.state["phase"], "ready")
        self.assertIn("persist", controller.state["last_error"])

    async def test_edit_after_choice_forces_fresh_analysis(self) -> None:
        controller, claude, repository = self.make_controller()
        await self.analyze(controller)
        await controller.choose(1)

        controller.edit("short prompt but changed")
        self.assertEqual(controller.state["phase"], "draft")
        self.assertEqual(repository.decisions[-1][1], "edited")
        self.assertEqual(await controller.enter(), "analyzing")
        self.assertEqual(claude.calls, [])

    async def test_double_enter_while_analyzing_cannot_send(self) -> None:
        pause = asyncio.Event()
        repository = FakeRepository()
        claude = FakeClaudeClient()
        controller = ComposerController(
            claude_client=claude,
            optimizer=optimizer(pause=pause),
            repository=repository,
        )
        controller.edit("a long original prompt")

        self.assertEqual(await controller.enter(), "analyzing")
        await asyncio.sleep(0)
        self.assertEqual(await controller.enter(), "analyzing")
        self.assertEqual(claude.calls, [])
        pause.set()
        await controller.wait_for_analysis()

    async def test_analysis_timeout_returns_to_editable_unsent_draft(self) -> None:
        pause = asyncio.Event()
        repository = FakeRepository()
        claude = FakeClaudeClient()
        controller = ComposerController(
            claude_client=claude,
            optimizer=optimizer(pause=pause),
            repository=repository,
            analysis_timeout=0.01,
        )
        controller.edit("a long original prompt")

        await controller.enter()
        await controller.wait_for_analysis()

        self.assertEqual(controller.state["phase"], "draft")
        self.assertEqual(claude.calls, [])
        self.assertEqual(repository.decisions[-1][1], "failed")

    async def test_concurrent_second_enters_send_at_most_once(self) -> None:
        controller, claude, _ = self.make_controller(block=True)
        await self.analyze(controller)
        await controller.choose(1)

        first = asyncio.create_task(controller.enter())
        await claude.started.wait()
        second = asyncio.create_task(controller.enter())
        await asyncio.sleep(0)
        claude.release.set()
        await asyncio.gather(first, second)

        self.assertEqual(len(claude.calls), 1)

    async def test_send_failure_is_never_retried_automatically(self) -> None:
        controller, claude, repository = self.make_controller(fail_first=True)
        await self.analyze(controller)
        await controller.choose(1)

        self.assertEqual(await controller.enter(), "send_failed")
        self.assertEqual(controller.state["phase"], "ready")
        self.assertEqual(len(claude.calls), 1)
        self.assertTrue(repository.send_results[-1][1]["error"])
        first_attempt_id = repository.send_attempts[-1][0][1]
        self.assertEqual(
            repository.send_results[-1][1]["send_attempt_id"],
            first_attempt_id,
        )

        self.assertEqual(await controller.enter(), "sent")
        self.assertEqual(len(claude.calls), 2)
        second_attempt_id = repository.send_attempts[-1][0][1]
        self.assertNotEqual(second_attempt_id, first_attempt_id)
        self.assertEqual(
            repository.send_results[-1][1]["send_attempt_id"],
            second_attempt_id,
        )

    async def test_follow_up_resumes_captured_claude_session(self) -> None:
        controller, claude, _ = self.make_controller()
        await self.analyze(controller)
        await controller.choose("s")
        await controller.enter()

        controller.edit("a follow-up prompt")
        await controller.enter()
        await controller.wait_for_analysis()
        await controller.choose("s")
        await controller.enter()

        self.assertEqual(claude.calls[0][1], None)
        self.assertEqual(claude.calls[1][1], "claude-session-1")

    async def test_success_logs_session_usage_and_suggestion_outcomes(
        self,
    ) -> None:
        controller, _, repository = self.make_controller()
        await self.analyze(controller)
        await controller.choose(1)

        await controller.enter()

        self.assertEqual(len(repository.sessions), 1)
        _, session_options = repository.sessions[0]
        self.assertEqual(session_options["actual_cost"], 10.0)
        self.assertEqual(
            session_options["analysis_id"],
            repository.decisions[0][0],
        )
        self.assertEqual(repository.outcomes[0][0][:2], ("suggestion-1", True))

    async def test_interactive_send_failure_preserves_ready_retry(self) -> None:
        controller = MagicMock()
        controller.state = {
            "phase": "ready",
            "decision": "accepted",
            "draft_text": "approved prompt",
            "last_error": None,
        }
        calls = 0

        async def enter(**_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                controller.state["last_error"] = "transport failed"
                return "send_failed"
            controller.state["phase"] = "draft"
            controller.state["draft_text"] = ""
            return "sent"

        controller.enter = AsyncMock(side_effect=enter)
        args = SimpleNamespace(
            cwd=".", claude="claude", user_id="user", project="project"
        )
        with (
            patch("cli.app.ComposerController", return_value=controller),
            patch("cli.app.ClaudeClient"),
            patch("builtins.input", side_effect=["", ""]),
            patch("cli.app._prompt_multiline", side_effect=EOFError),
        ):
            self.assertEqual(await _interactive(args), 0)

        self.assertEqual(controller.enter.await_count, 2)
        controller.edit.assert_not_called()

    async def test_interactive_reopens_retained_failed_draft(self) -> None:
        controller = MagicMock()
        controller.state = {
            "phase": "draft",
            "decision": None,
            "draft_text": "retained after analysis failure",
        }
        args = SimpleNamespace(
            cwd=".", claude="claude", user_id="user", project="project"
        )
        with (
            patch("cli.app.ComposerController", return_value=controller),
            patch("cli.app.ClaudeClient"),
            patch("cli.app._prompt_multiline", side_effect=EOFError) as prompt,
        ):
            self.assertEqual(await _interactive(args), 0)

        prompt.assert_called_once_with("retained after analysis failure")

    async def test_interactive_ready_e_reopens_selected_multiline_draft(self) -> None:
        controller = MagicMock()
        controller.state = {
            "phase": "ready",
            "decision": "accepted",
            "draft_text": "approved\nmultiline prompt",
            "last_error": None,
        }

        def edit(text):
            controller.state["phase"] = "draft"
            controller.state["draft_text"] = text

        controller.edit.side_effect = edit
        args = SimpleNamespace(
            cwd=".", claude="claude", user_id="user", project="project"
        )
        with (
            patch("cli.app.ComposerController", return_value=controller),
            patch("cli.app.ClaudeClient"),
            patch("builtins.input", return_value="E"),
            patch("cli.app._prompt_multiline", side_effect=EOFError) as prompt,
        ):
            self.assertEqual(await _interactive(args), 0)

        controller.edit.assert_called_once_with("approved\nmultiline prompt")
        prompt.assert_called_once_with("approved\nmultiline prompt")


if __name__ == "__main__":
    unittest.main()
