import os
import unittest
from copy import deepcopy
from unittest.mock import patch

from agent.nodes.reason import call_reasoning_model
from db.blocks import hash_block
from db.repo import (
    find_similar,
    load_context,
    log_session,
    log_suggestions,
    match_blocks,
    record_outcome,
)
from model.predictor import predict, predict_many


class StubBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stub_environment = patch.dict(
            os.environ,
            {"TOKENLENS_STUB": "1"},
            clear=False,
        )
        self.stub_environment.start()

    def tearDown(self) -> None:
        self.stub_environment.stop()

    def test_context_is_scoped_and_uses_project_memory(self) -> None:
        ctx, profile = load_context("user-9", "session-7", "fixture-project")

        self.assertEqual(ctx["user_id"], "user-9")
        self.assertEqual(ctx["session_id"], "session-7")
        self.assertEqual(profile["user_id"], "user-9")
        self.assertEqual(ctx["calibration_bias"], -18.0)
        self.assertEqual(ctx["completion_ratio_median"], 0.34)

        ctx_without_project, _ = load_context("user-9", "session-8", None)
        self.assertEqual(ctx_without_project["calibration_bias"], -11.0)
        self.assertEqual(ctx_without_project["completion_ratio_median"], 0.38)

    def test_predictions_do_not_mutate_the_shared_context(self) -> None:
        ctx, _ = load_context("user-1", "session-1", None)
        before = deepcopy(ctx)

        single = predict("A long prompt", ctx)
        batch = predict_many(["Rewrite one", "Rewrite two"], ctx)

        self.assertEqual(ctx, before)
        self.assertEqual(single, batch[0])
        self.assertEqual(len(batch), 2)
        self.assertIsNot(batch[0], batch[1])
        self.assertLessEqual(single["p10"], single["p50"])
        self.assertLessEqual(single["p50"], single["p90"])

    def test_repository_and_reasoning_stubs_return_committed_fixtures(self) -> None:
        ctx, _ = load_context("user-1", "session-1", "fixture-project")
        prediction = predict("Prompt with repeated content", ctx)
        examples = find_similar("Prompt with repeated content", "user-1", k=1)
        candidates = call_reasoning_model(
            "Prompt with repeated content",
            examples,
            ["dedupe"],
        )
        hits = match_blocks(
            "```sql\nCREATE TABLE repeated_fixture "
            "(id bigint primary key);\n```",
            "user-1",
            "fixture-project",
        )

        self.assertEqual(len(examples), 1)
        self.assertGreater(examples[0]["actual_savings"], 0)
        self.assertEqual([item["suggestion_type"] for item in candidates], ["dedupe"])
        self.assertGreaterEqual(hits[0]["occurrences"], 3)
        self.assertGreaterEqual(hits[0]["collapse_accepted"], 1)
        self.assertEqual(
            hits[0]["block_hash"],
            hash_block(hits[0]["normalized_text"]),
        )

        session_document_id = log_session(
            "Prompt with repeated content",
            prediction,
            ctx,
        )
        scored = {
            **candidates[0],
            "predicted_cost": prediction,
            "estimated_savings": 120.0,
        }
        suggestion_ids = log_suggestions("session-1", [scored])
        record_outcome(suggestion_ids[0], True, 118.0)

        self.assertTrue(session_document_id.startswith("stub-session-"))
        self.assertEqual(suggestion_ids, ["stub-suggestion-1"])

    def test_non_stub_boundaries_fail_instead_of_faking_real_services(self) -> None:
        ctx, _ = load_context("user-1", "session-1", None)
        with patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False):
            with self.assertRaises(NotImplementedError):
                predict("A prompt", ctx)
            with patch(
                "db.repo._database",
                side_effect=RuntimeError("real database invoked"),
            ):
                with self.assertRaisesRegex(RuntimeError, "real database invoked"):
                    find_similar("A prompt", "user-1")


if __name__ == "__main__":
    unittest.main()
