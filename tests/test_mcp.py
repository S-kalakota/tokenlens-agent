import asyncio
import importlib.util
import os
import unittest
from unittest.mock import patch

from mcp_server import build_mcp_server, optimize_prompt


class McpAdapterTests(unittest.TestCase):
    def test_sync_adapter_returns_full_public_identity(self) -> None:
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False):
            response = optimize_prompt("Repeated context. " * 60, "mcp-session")

        self.assertTrue(response["analysis_id"])
        self.assertEqual(len(response["prompt_hash"]), 64)
        self.assertLessEqual(len(response["suggestions"]), 3)
        self.assertIn("original_predicted_cost", response)

    @unittest.skipUnless(importlib.util.find_spec("mcp"), "MCP dependency absent")
    def test_installed_server_registers_both_diagnostic_tools(self) -> None:
        server = build_mcp_server()
        tools = asyncio.run(server.list_tools())

        self.assertEqual(
            {tool.name for tool in tools},
            {"optimize_prompt", "record_outcome"},
        )


if __name__ == "__main__":
    unittest.main()
