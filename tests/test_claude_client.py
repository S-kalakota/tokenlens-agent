import os
import tempfile
import unittest
from pathlib import Path

from cli.claude_client import ClaudeClient, ClaudeSendError

SCRIPT = """#!/usr/bin/env python3
import json
import os
import sys

prompt = sys.argv[sys.argv.index('-p') + 1]
if '--resume' in sys.argv:
    prompt = sys.argv[sys.argv.index('--resume') + 2]
if prompt == 'fail':
    print('delivery uncertain', file=sys.stderr)
    raise SystemExit(7)
if prompt == 'hook-blocked':
    print(json.dumps({
        'type': 'system',
        'subtype': 'hook_response',
        'hook_event': 'UserPromptSubmit',
        'outcome': 'success',
        'stdout': json.dumps({
            'decision': 'block',
            'reason': 'TokenLens paused this prompt',
        }),
        'output': '',
    }))
    print(json.dumps({
        'type': 'result',
        'subtype': 'success',
        'is_error': False,
        'terminal_reason': 'hook_stopped',
        'session_id': 'captured-session',
        'result': '',
    }))
    raise SystemExit(0)
if prompt == 'result-error':
    print(json.dumps({
        'type': 'result',
        'subtype': 'error_during_execution',
        'is_error': True,
        'session_id': 'captured-session',
        'errors': ['agent loop failed'],
    }))
    raise SystemExit(0)
if prompt == 'missing-result':
    print(json.dumps({'type': 'system', 'session_id': 'captured-session'}))
    raise SystemExit(0)
print(json.dumps({'type': 'system', 'session_id': 'captured-session'}))
print(json.dumps({
    'type': 'result',
    'session_id': 'captured-session',
    'result': os.getcwd() + '|' + prompt,
    'usage': {'input_tokens': 12},
}))
"""


class ClaudeClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cwd = Path(self.temporary.name)
        self.executable = self.cwd / "fake-claude"
        self.executable.write_text(SCRIPT, encoding="utf-8")
        self.executable.chmod(0o755)
        self.client = ClaudeClient(cwd=self.cwd, executable=str(self.executable))

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_uses_fixed_cwd_and_captures_session_usage(self) -> None:
        result = await self.client.send("hello")

        self.assertEqual(result["session_id"], "captured-session")
        self.assertEqual(result["usage"], {"input_tokens": 12})
        actual_cwd, _, prompt = result["result"].partition("|")
        self.assertTrue(os.path.samefile(actual_cwd, self.cwd))
        self.assertEqual(prompt, "hello")

    async def test_resume_is_an_explicit_argv_pair(self) -> None:
        command = self.client.command("follow up", "session-1")

        self.assertEqual(
            command[0:4],
            [
                str(self.executable),
                "--settings",
                '{"enabledPlugins":{"tokenlens@tokenlens":false}}',
                "-p",
            ],
        )
        self.assertIn("--resume", command)
        self.assertEqual(command[command.index("--resume") + 1], "session-1")
        self.assertIn("--include-hook-events", command)
        result = await self.client.send("follow up", "session-1")
        self.assertIn("|follow up", result["result"])

    async def test_plugin_bypass_is_configurable(self) -> None:
        client = ClaudeClient(
            cwd=self.cwd,
            executable=str(self.executable),
            gate_plugin=None,
        )

        command = client.command("hello")

        self.assertEqual(command[0:2], [str(self.executable), "-p"])
        self.assertNotIn("--settings", command)

    async def test_prompt_is_not_interpreted_by_a_shell(self) -> None:
        marker = self.cwd / "should-not-exist"
        prompt = f"$(touch {marker})"

        result = await self.client.send(prompt)

        self.assertFalse(marker.exists())
        self.assertTrue(result["result"].endswith("|" + prompt))

    async def test_nonzero_exit_raises_without_retry(self) -> None:
        with self.assertRaises(ClaudeSendError) as raised:
            await self.client.send("fail")

        self.assertEqual(raised.exception.returncode, 7)
        self.assertIn("delivery uncertain", str(raised.exception))

    async def test_hook_block_on_zero_exit_is_a_send_failure(self) -> None:
        with self.assertRaises(ClaudeSendError) as raised:
            await self.client.send("hook-blocked")

        self.assertIsNone(raised.exception.returncode)
        self.assertIn("TokenLens paused", str(raised.exception))

    async def test_error_result_on_zero_exit_is_a_send_failure(self) -> None:
        with self.assertRaises(ClaudeSendError) as raised:
            await self.client.send("result-error")

        self.assertIn("agent loop failed", str(raised.exception))

    async def test_zero_exit_without_result_is_a_send_failure(self) -> None:
        with self.assertRaises(ClaudeSendError) as raised:
            await self.client.send("missing-result")

        self.assertIn("without a result event", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
