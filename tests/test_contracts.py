import unittest
from importlib import import_module

from agent.graph import invocation_config
from agent.state import AgentState
from db.client import COLLECTION_NAMES
from db.indexes import INDEX_CONTRACTS, VECTOR_INDEX_CONTRACT
from model.featurizer import (
    CONTEXT_DERIVED_FEATURES,
    FEATURE_ORDER,
    POST_EXECUTION_IMPUTATION_SOURCES,
    POST_EXECUTION_ONLY_FEATURES,
    PROMPT_DERIVED_FEATURES,
    validate_feature_contract,
)


class ContractTests(unittest.TestCase):
    def test_phase_zero_modules_import_without_optional_dependencies(self) -> None:
        modules = (
            "contracts",
            "config",
            "agent.graph",
            "agent.state",
            "agent.nodes.gate",
            "agent.nodes.retrieve",
            "agent.nodes.reason",
            "agent.nodes.rescore",
            "agent.nodes.package",
            "model.featurizer",
            "model.predictor",
            "db.client",
            "db.repo",
            "db.profile",
            "db.blocks",
            "db.schemas",
            "db.indexes",
            "db.backfill",
            "scripts.run_local",
            "mcp_server",
        )

        for module in modules:
            with self.subTest(module=module):
                self.assertIsNotNone(import_module(module))

    def test_feature_buckets_are_disjoint_and_complete(self) -> None:
        validate_feature_contract()
        flattened = (
            *PROMPT_DERIVED_FEATURES,
            *CONTEXT_DERIVED_FEATURES,
            *POST_EXECUTION_ONLY_FEATURES,
        )

        self.assertEqual(FEATURE_ORDER, flattened)
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertEqual(
            set(POST_EXECUTION_ONLY_FEATURES),
            set(POST_EXECUTION_IMPUTATION_SOURCES),
        )

    def test_all_memory_collections_are_declared(self) -> None:
        self.assertEqual(
            set(COLLECTION_NAMES),
            {
                "sessions",
                "prompt_embeddings",
                "suggestions",
                "user_profile",
                "block_library",
                "checkpoints",
            },
        )
        self.assertEqual(
            VECTOR_INDEX_CONTRACT["source_field"],
            "prompt_text",
        )
        self.assertTrue(
            any(
                contract["collection"] == "checkpoints"
                and contract["expire_after_seconds"] == 86_400
                for contract in INDEX_CONTRACTS
            )
        )

    def test_agent_state_starts_with_only_invocation_keys(self) -> None:
        state: AgentState = {
            "prompt": "Optimize this prompt",
            "session_id": "session-1",
        }
        self.assertEqual(set(state), {"prompt", "session_id"})

    def test_thread_id_is_mandatory(self) -> None:
        self.assertEqual(
            invocation_config("session-1"),
            {"configurable": {"thread_id": "session-1"}},
        )
        with self.assertRaises(ValueError):
            invocation_config(" ")


if __name__ == "__main__":
    unittest.main()
