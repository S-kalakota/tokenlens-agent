import os
import unittest
from copy import deepcopy
from unittest.mock import patch

from agent.graph import LocalCompiledGraph, build_graph, invocation_config
from agent.nodes.gate import gate
from agent.nodes.package import package
from agent.nodes.reason import call_reasoning_model, reason, select_reason_model
from agent.nodes.rescore import rescore
from agent.nodes.retrieve import retrieve


def context() -> dict:
    return {
        "user_id": "user-1",
        "session_id": "session-1",
        "project": "project-1",
        "target_model": "openai/gpt-4.1",
        "session_turn_index": 3,
        "recent_costs": [600.0, 900.0],
        "completion_ratio_median": 0.35,
        "calibration_bias": -10.0,
    }


def profile(*, p40: float = 500.0) -> dict:
    return {
        "user_id": "user-1",
        "cost_quantiles": {"p40": p40, "p50": 900.0, "p90": 1800.0, "n": 20},
        "per_project": {},
        "accept_rate_by_type": {
            "dedupe": {"rate": 0.8, "accepted": 16, "total": 20},
            "trim_boilerplate": {"rate": 0.1, "accepted": 2, "total": 20},
            "collapse_block": {"rate": 0.5, "accepted": 10, "total": 20},
        },
        "calibration": {"bias": -10.0, "mae": 50.0, "n": 20},
        "completion_ratio_median": 0.35,
        "updated_at": None,
    }


class NodeBehaviorTests(unittest.TestCase):
    def test_rescore_applies_calibration_to_the_savings_delta(self) -> None:
        candidate = {
            "rewrite": "short prompt",
            "rationale": "remove repetition",
            "suggestion_type": "dedupe",
        }
        state = {
            "prompt": "long prompt",
            "session_id": "session-1",
            "ctx": context(),
            "predicted_cost": {"p10": 80.0, "p50": 100.0, "p90": 120.0},
            "candidate_rewrites": [candidate],
        }

        for bias, expected_savings in ((20.0, 30.0), (-20.0, 70.0)):
            with self.subTest(calibration_bias=bias):
                state["ctx"] = {**context(), "calibration_bias": bias}
                with patch(
                    "agent.nodes.rescore.predict_many",
                    return_value=[{"p10": 40.0, "p50": 50.0, "p90": 60.0}],
                ):
                    result = rescore(state)

                self.assertEqual(
                    result["scored_rewrites"][0]["estimated_savings"],
                    expected_savings,
                )

    def test_rescore_drops_non_positive_calibrated_savings(self) -> None:
        state = {
            "prompt": "long prompt",
            "session_id": "session-1",
            "ctx": {**context(), "calibration_bias": 20.0},
            "predicted_cost": {"p10": 80.0, "p50": 100.0, "p90": 120.0},
            "candidate_rewrites": [
                {
                    "rewrite": "barely shorter",
                    "rationale": "small trim",
                    "suggestion_type": "dedupe",
                }
            ],
        }
        with patch(
            "agent.nodes.rescore.predict_many",
            return_value=[{"p10": 80.0, "p50": 90.0, "p90": 100.0}],
        ):
            result = rescore(state)

        self.assertEqual(result["scored_rewrites"], [])

    def test_retrieve_filters_mature_low_acceptance_types(self) -> None:
        state = {
            "prompt": "A costly prompt",
            "session_id": "session-1",
            "ctx": context(),
            "profile": profile(),
        }
        with patch("agent.nodes.retrieve.find_similar", return_value=[]) as find:
            result = retrieve(state)

        find.assert_called_once_with("A costly prompt", "user-1", k=3)
        self.assertNotIn("trim_boilerplate", result["allowed_types"])
        self.assertIn("dedupe", result["allowed_types"])
        self.assertIn("summarize_context", result["allowed_types"])

    def test_retrieve_reuses_checkpointed_examples(self) -> None:
        remembered = [
            {
                "prompt_excerpt": "old prompt",
                "rewrite": "old rewrite",
                "rationale": "accepted before",
                "suggestion_type": "dedupe",
                "actual_savings": 200.0,
                "similarity": 0.9,
            }
        ]
        state = {
            "prompt": "A related follow-up",
            "session_id": "session-1",
            "ctx": context(),
            "profile": profile(),
            "retrieved_examples": remembered,
        }
        with patch("agent.nodes.retrieve.find_similar") as find:
            result = retrieve(state)

        find.assert_not_called()
        self.assertIs(result["retrieved_examples"], remembered)
        self.assertIn("allowed_types", result)

    def test_retrieve_reuses_a_checkpointed_empty_result(self) -> None:
        state = {
            "prompt": "A related follow-up",
            "session_id": "session-1",
            "ctx": context(),
            "profile": profile(),
            "retrieved_examples": [],
        }
        with patch("agent.nodes.retrieve.find_similar") as find:
            result = retrieve(state)

        find.assert_not_called()
        self.assertEqual(result["retrieved_examples"], [])

    def test_package_ranks_by_expected_value_and_uses_distinct_key(self) -> None:
        state = {
            "prompt": "prompt",
            "session_id": "session-1",
            "profile": profile(),
            "scored_rewrites": [
                {
                    "rewrite": "large but unpopular",
                    "rationale": "test",
                    "suggestion_type": "trim_boilerplate",
                    "predicted_cost": {"p10": 300.0, "p50": 400.0, "p90": 500.0},
                    "estimated_savings": 500.0,
                },
                {
                    "rewrite": "popular",
                    "rationale": "test",
                    "suggestion_type": "dedupe",
                    "predicted_cost": {"p10": 500.0, "p50": 600.0, "p90": 700.0},
                    "estimated_savings": 200.0,
                },
            ],
        }

        result = package(state)

        self.assertEqual(set(result), {"suggestions"})
        self.assertEqual(result["suggestions"][0]["rewrite"], "popular")
        self.assertEqual(result["suggestions"][0]["expected_value"], 160.0)
        self.assertEqual(result["suggestions"][1]["expected_value"], 50.0)

    def test_openrouter_response_retries_once_and_enforces_allowed_types(self) -> None:
        valid = """[
          {"rewrite":"short","rationale":"deduplicated","suggestion_type":"dedupe"},
          {"rewrite":"forbidden","rationale":"trimmed",
           "suggestion_type":"trim_boilerplate"}
        ]"""
        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch(
                "agent.nodes.reason._invoke_openrouter",
                side_effect=["not json", valid],
            ) as invoke,
        ):
            candidates = call_reasoning_model("long prompt", [], ["dedupe"])

        self.assertEqual(invoke.call_count, 2)
        self.assertEqual([item["rewrite"] for item in candidates], ["short"])

    def test_similar_accepted_savings_route_to_the_strong_model(self) -> None:
        state = {
            "prompt": "A moderately expensive prompt",
            "session_id": "session-1",
            "profile": profile(),
            "predicted_cost": {"p10": 500.0, "p50": 650.0, "p90": 800.0},
            "allowed_types": ["dedupe"],
            "retrieved_examples": [],
        }
        environment = {
            "TOKENLENS_REASON_CHEAP_MODEL": "test/cheap",
            "TOKENLENS_REASON_STRONG_MODEL": "test/strong",
            "TOKENLENS_REASON_STRONG_UPSIDE_TOKENS": "300",
            "TOKENLENS_REASON_MODEL": "",
            "OPENROUTER_MODEL": "",
        }
        with patch.dict(os.environ, environment, clear=False):
            cheap_model, cold_upside = select_reason_model(state)
            state["retrieved_examples"] = [
                {
                    "prompt_excerpt": "similar prompt",
                    "rewrite": "shorter prompt",
                    "rationale": "accepted before",
                    "suggestion_type": "dedupe",
                    "actual_savings": 600.0,
                    "similarity": 0.95,
                }
            ]
            strong_model, remembered_upside = select_reason_model(state)

        self.assertEqual(cheap_model, "test/cheap")
        self.assertEqual(strong_model, "test/strong")
        self.assertLess(cold_upside, 300.0)
        self.assertGreaterEqual(remembered_upside, 300.0)

    def test_full_route_collapse_tracks_one_removed_matching_block(self) -> None:
        state = {
            "prompt": "Keep this section. Remove this repeated schema.",
            "session_id": "session-1",
            "profile": profile(),
            "predicted_cost": {"p10": 600.0, "p50": 800.0, "p90": 1000.0},
            "allowed_types": ["collapse_block", "dedupe"],
            "retrieved_examples": [],
            "block_hits": [
                {
                    "block_hash": "large-but-retained",
                    "kind": "line_window",
                    "normalized_text": "Keep this section.",
                    "start_line": 1,
                    "end_line": 1,
                    "token_count": 900,
                    "occurrences": 2,
                    "collapse_accepted": 0,
                },
                {
                    "block_hash": "removed-schema",
                    "kind": "line_window",
                    "normalized_text": "Remove this repeated schema.",
                    "start_line": 1,
                    "end_line": 1,
                    "token_count": 500,
                    "occurrences": 2,
                    "collapse_accepted": 0,
                },
                {
                    "block_hash": "removed-smaller",
                    "kind": "line_window",
                    "normalized_text": "repeated schema.",
                    "start_line": 1,
                    "end_line": 1,
                    "token_count": 100,
                    "occurrences": 2,
                    "collapse_accepted": 0,
                },
            ],
        }
        generated = [
            {
                "rewrite": "Keep this section. Reuse the prior schema.",
                "rationale": "collapse recurrence",
                "suggestion_type": "collapse_block",
            },
            {
                "rewrite": "Keep this section.",
                "rationale": "trim repetition",
                "suggestion_type": "dedupe",
                "source_block_hashes": ["untrusted-model-hash"],
            },
        ]
        with patch("agent.nodes.reason.call_reasoning_model", return_value=generated):
            result = reason(state)

        self.assertEqual(
            result["candidate_rewrites"][0]["source_block_hashes"],
            ["removed-schema"],
        )
        self.assertNotIn("source_block_hashes", result["candidate_rewrites"][1])

    def test_collapse_does_not_claim_a_block_retained_by_the_rewrite(self) -> None:
        state = {
            "prompt": "Keep recurring schema. Remove unrelated preamble.",
            "session_id": "session-1",
            "profile": profile(),
            "predicted_cost": {"p10": 600.0, "p50": 800.0, "p90": 1000.0},
            "allowed_types": ["collapse_block"],
            "retrieved_examples": [],
            "block_hits": [
                {
                    "block_hash": "retained-schema",
                    "kind": "line_window",
                    "normalized_text": "recurring schema.",
                    "start_line": 1,
                    "end_line": 1,
                    "token_count": 500,
                    "occurrences": 2,
                    "collapse_accepted": 0,
                }
            ],
        }
        generated = [
            {
                "rewrite": "Keep recurring schema.",
                "rationale": "trim prose",
                "suggestion_type": "collapse_block",
            }
        ]
        with patch("agent.nodes.reason.call_reasoning_model", return_value=generated):
            result = reason(state)

        self.assertNotIn("source_block_hashes", result["candidate_rewrites"][0])


class LocalGraphTests(unittest.TestCase):
    def test_real_mode_refuses_uncheckpointed_fallback(self) -> None:
        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("agent.graph._mongo_checkpointer", return_value=None),
            patch("agent.graph._langgraph_compiled", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "persistent checkpoints"):
                build_graph()

    def test_full_route_uses_one_context_and_returns_ranked_suggestions(self) -> None:
        original_ctx = context()
        candidates = [
            {
                "rewrite": "short prompt",
                "rationale": "Remove repetition",
                "suggestion_type": "dedupe",
            }
        ]
        observed_contexts = []

        def predict_many(_prompts, ctx):
            observed_contexts.append(ctx)
            return [{"p10": 450.0, "p50": 500.0, "p90": 600.0}]

        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(original_ctx, profile()),
            ) as load,
            patch("agent.nodes.gate.match_blocks", return_value=[]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
            ),
            patch("agent.nodes.retrieve.find_similar", return_value=[]),
            patch("agent.nodes.reason.call_reasoning_model", return_value=candidates),
            patch("agent.nodes.rescore.predict_many", side_effect=predict_many),
        ):
            graph = build_graph(force_local=True)
            result = graph.invoke(
                {
                    "prompt": "expensive repeated prompt",
                    "session_id": "session-1",
                    "user_id": "user-1",
                    "project": "project-1",
                },
                invocation_config("session-1"),
            )

        self.assertIsInstance(graph, LocalCompiledGraph)
        load.assert_called_once_with("user-1", "session-1", "project-1")
        self.assertEqual(result["route"], "full")
        self.assertIs(observed_contexts[0], original_ctx)
        # The fixture context's -10 residual means prior savings estimates were
        # pessimistic, so calibration raises the raw 500-token delta to 510.
        self.assertEqual(result["suggestions"][0]["estimated_savings"], 510.0)

    def test_known_block_uses_deterministic_route_without_llm(self) -> None:
        prompt = "before\nline one\nline two\nline three\nafter"
        hit = {
            "block_hash": "digest",
            "kind": "line_window",
            "normalized_text": "line one line two line three",
            "start_line": 2,
            "end_line": 4,
            "token_count": 300,
            "occurrences": 4,
            "collapse_accepted": 1,
        }
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(context(), profile()),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[hit]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
            ),
            patch("agent.nodes.retrieve.find_similar") as find,
            patch("agent.nodes.reason.call_reasoning_model") as reason,
            patch(
                "agent.nodes.rescore.predict_many",
                return_value=[{"p10": 300.0, "p50": 400.0, "p90": 500.0}],
            ),
        ):
            result = build_graph(force_local=True).invoke(
                {"prompt": prompt, "session_id": "session-1"},
                invocation_config("session-1"),
            )

        self.assertEqual(result["route"], "deterministic")
        find.assert_not_called()
        reason.assert_not_called()
        self.assertIn("Reuse prior block", result["suggestions"][0]["rewrite"])
        self.assertEqual(result["suggestions"][0]["source_block_hashes"], ["digest"])

    def test_deterministic_candidate_tracks_only_the_selected_block(self) -> None:
        prompt = "before\nlarge block\nafter"
        smaller = {
            "block_hash": "smaller",
            "kind": "line_window",
            "normalized_text": "before",
            "start_line": 1,
            "end_line": 1,
            "token_count": 100,
            "occurrences": 9,
            "collapse_accepted": 3,
        }
        selected = {
            "block_hash": "selected",
            "kind": "line_window",
            "normalized_text": "large block",
            "start_line": 2,
            "end_line": 2,
            "token_count": 500,
            "occurrences": 3,
            "collapse_accepted": 1,
        }
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(context(), profile()),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[smaller, selected]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
            ),
        ):
            update = gate({"prompt": prompt, "session_id": "session-1"})

        self.assertEqual(update["route"], "deterministic")
        self.assertEqual(
            update["candidate_rewrites"][0]["source_block_hashes"],
            ["selected"],
        )

    def test_stub_block_memory_requires_an_exact_fingerprint(self) -> None:
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False):
            self.assertEqual(
                gate(
                    {
                        "prompt": "Mention repeated_fixture without its stored block",
                        "session_id": "session-1",
                    }
                )["block_hits"],
                [],
            )

    def test_stub_exact_block_takes_deterministic_route_with_savings(self) -> None:
        prompt = (
            "Use the recurring schema below.\n```sql\n"
            "CREATE TABLE repeated_fixture (id bigint primary key);\n```"
        )
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False):
            result = build_graph(force_local=True).invoke(
                {"prompt": prompt, "session_id": "session-1"},
                invocation_config("session-1"),
            )

        self.assertEqual(result["route"], "deterministic")
        self.assertEqual(len(result["suggestions"]), 1)
        self.assertGreater(result["suggestions"][0]["estimated_savings"], 0)

    def test_low_cost_route_skips_every_downstream_cost(self) -> None:
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(context(), profile(p40=700.0)),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 200.0, "p50": 350.0, "p90": 450.0},
            ),
            patch("agent.nodes.retrieve.find_similar") as find,
            patch("agent.nodes.reason.call_reasoning_model") as reason,
            patch("agent.nodes.rescore.predict_many") as predict_many,
        ):
            result = build_graph(force_local=True).invoke(
                {"prompt": "small prompt", "session_id": "session-1"},
                invocation_config("session-1"),
            )

        self.assertEqual(result["route"], "skip")
        self.assertEqual(result["suggestions"], [])
        find.assert_not_called()
        reason.assert_not_called()
        predict_many.assert_not_called()

    def test_always_suggest_override_sends_low_cost_prompt_to_reasoning(self) -> None:
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(context(), profile(p40=700.0)),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 10.0, "p50": 100.0, "p90": 200.0},
            ),
        ):
            update = gate(
                {
                    "prompt": "small prompt",
                    "session_id": "session-1",
                    "force_suggestions": True,
                }
            )

        self.assertEqual(update["route"], "full")

    def test_gate_clears_turn_local_checkpoint_results(self) -> None:
        state = {"prompt": "new turn", "session_id": "session-1"}
        state.update(
            {
                "candidate_rewrites": [{"rewrite": "stale"}],
                "scored_rewrites": [{"rewrite": "stale"}],
                "suggestions": [{"rewrite": "stale"}],
            }
        )
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(context(), profile()),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 10.0, "p50": 100.0, "p90": 200.0},
            ),
        ):
            update = gate(state)

        self.assertEqual(update["candidate_rewrites"], [])
        self.assertEqual(update["scored_rewrites"], [])
        self.assertEqual(update["suggestions"], [])


class StreamingGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_gate_cost_is_the_first_async_update(self) -> None:
        with (
            patch(
                "agent.nodes.gate.load_context",
                return_value=(deepcopy(context()), profile(p40=700.0)),
            ),
            patch("agent.nodes.gate.match_blocks", return_value=[]),
            patch(
                "agent.nodes.gate.predict",
                return_value={"p10": 200.0, "p50": 350.0, "p90": 450.0},
            ),
        ):
            updates = [
                update
                async for update in build_graph(force_local=True).astream(
                    {"prompt": "small prompt", "session_id": "session-1"},
                    invocation_config("session-1"),
                    stream_mode="updates",
                )
            ]

        self.assertEqual(list(updates[0]), ["gate"])
        self.assertEqual(updates[0]["gate"]["predicted_cost"]["p50"], 350.0)
        self.assertEqual(list(updates[1]), ["package"])


if __name__ == "__main__":
    unittest.main()
