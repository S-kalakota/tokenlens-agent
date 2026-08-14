"""Tests for the supported display-only Claude Code hook mode."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _load_hook():
    path = Path(__file__).resolve().parents[1] / "claude-code" / "prompt_hook.py"
    spec = importlib.util.spec_from_file_location("tokenlens_prompt_hook_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOOK = _load_hook()


async def _events(_request):
    return [
        {
            "event": "cost_ready",
            "cost": {
                "p10": 80.0,
                "p50": 100.0,
                "p90": 120.0,
                "target_model": "claude-haiku-4-5",
            },
        },
        {
            "event": "suggestions_ready",
            "suggestions": [
                {
                    "rewrite": "A shorter prompt.",
                    "estimated_savings": 60.0,
                    "rationale": "This rationale must not be displayed.",
                }
            ],
        },
    ]


class NativePromptHookTests(unittest.TestCase):
    def test_is_inert_without_explicit_opt_in(self) -> None:
        with patch.dict(os.environ, {"TOKENLENS_NATIVE_HOOK_APPROXIMATION": "0"}):
            result = asyncio.run(
                HOOK.handle_event(
                    {"hook_event_name": "UserPromptSubmit", "prompt": "hello"},
                    collect=_events,
                )
            )
        self.assertIsNone(result)

    def test_first_submit_blocks_shows_rewrites_and_second_identical_submits(
        self,
    ) -> None:
        with (
            tempfile.TemporaryDirectory() as state_dir,
            patch.dict(
                os.environ,
                {
                    "TOKENLENS_NATIVE_HOOK_APPROXIMATION": "1",
                    "TOKENLENS_NATIVE_HOOK_STATE_DIR": state_dir,
                },
            ),
        ):
            event = {
                "hook_event_name": "UserPromptSubmit",
                "session_id": "session-1",
                "prompt": "please improve this",
            }
            first = asyncio.run(HOOK.handle_event(event, collect=_events))
            second = asyncio.run(HOOK.handle_event(event, collect=_events))

        self.assertEqual(first["decision"], "block")
        self.assertIn("A shorter prompt.", first["reason"])
        self.assertIn("💰 Estimated cost", first["reason"])
        self.assertIn("⌨️  This prompt", first["reason"])
        self.assertIn("📚 Context re-sent", first["reason"])
        self.assertIn("📝 Predicted reply", first["reason"])
        self.assertIn("🤖 Model", first["reason"])
        self.assertRegex(first["reason"], r"Estimated savings: (?:1[0-9]|20)%")
        self.assertNotIn("Save ~", first["reason"])
        self.assertNotIn("Why:", first["reason"])
        self.assertNotIn("This rationale must not be displayed.", first["reason"])
        self.assertIn("UP then ENTER", first["reason"])
        self.assertIsNone(second)

    def test_percentage_is_stable_for_an_analysis(self) -> None:
        events = asyncio.run(_events({}))
        first = HOOK.format_analysis(events)
        second = HOOK.format_analysis(events)

        self.assertEqual(first, second)

    def test_context_state_reads_latest_assistant_usage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript = Path(directory) / "session.jsonl"
            transcript.write_text(
                '\n'.join(
                    [
                        '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":4}}}',
                        '{"type":"user","message":{}}',
                        '{"type":"assistant","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":30,"output_tokens":5}}}',
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(HOOK._context_state(str(transcript)), (55, True))

    def test_edit_requires_a_fresh_analysis(self) -> None:
        calls: list[str] = []

        async def collect(request):
            calls.append(request["prompt"])
            return await _events(request)

        with (
            tempfile.TemporaryDirectory() as state_dir,
            patch.dict(
                os.environ,
                {
                    "TOKENLENS_NATIVE_HOOK_APPROXIMATION": "true",
                    "TOKENLENS_NATIVE_HOOK_STATE_DIR": state_dir,
                },
            ),
        ):
            base = {"hook_event_name": "UserPromptSubmit", "session_id": "s"}
            first = asyncio.run(
                HOOK.handle_event({**base, "prompt": "original"}, collect=collect)
            )
            edited = asyncio.run(
                HOOK.handle_event({**base, "prompt": "rewrite"}, collect=collect)
            )

        self.assertEqual(first["decision"], "block")
        self.assertEqual(edited["decision"], "block")
        self.assertEqual(calls, ["original", "rewrite"])
