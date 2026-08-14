import unittest
from unittest.mock import patch

from cli.state import prompt_hash
from optimization_service import analyze_draft, collect_analysis


class FakeGraph:
    async def astream(self, state, config, stream_mode="updates"):
        self.state = state
        self.config = config
        self.stream_mode = stream_mode
        yield {
            "gate": {
                "predicted_cost": {
                    "p10": 800.0,
                    "p50": 1000.0,
                    "p90": 1200.0,
                },
                "route": "full",
            }
        }
        yield {
            "package": {
                "suggestions": [
                    {
                        "rewrite": "short",
                        "rationale": "deduplicate",
                        "suggestion_type": "dedupe",
                        "predicted_cost": {
                            "p10": 300.0,
                            "p50": 400.0,
                            "p90": 500.0,
                        },
                        "estimated_savings": 600.0,
                        "source_block_hashes": ["selected-block"],
                    }
                ]
            }
        }


class FailingBeforeCostGraph:
    async def astream(self, state, config, stream_mode="updates"):
        if False:
            yield {}
        raise RuntimeError("gate model unavailable")


def request(prompt="long prompt"):
    return {
        "analysis_id": "analysis-1",
        "draft_version": 3,
        "prompt": prompt,
        "prompt_hash": prompt_hash(prompt),
        "user_id": "user-1",
        "project": "project-1",
        "optimization_session_id": "optimization-1",
    }


class OptimizationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_cost_is_observable_before_draft_persistence(self) -> None:
        graph = FakeGraph()
        with (
            patch("optimization_service.repo.log_draft_analysis") as log_analysis,
            patch(
                "optimization_service.repo.log_suggestions",
                return_value=["suggestion-1"],
            ),
        ):
            events = analyze_draft(request(), graph=graph).__aiter__()
            first = await anext(events)
            self.assertEqual(first["event"], "cost_ready")
            log_analysis.assert_not_called()
            await anext(events)
            log_analysis.assert_called_once()

    async def test_emits_cost_before_suggestions_with_same_identity(self) -> None:
        graph = FakeGraph()
        with (
            patch("optimization_service.repo.log_draft_analysis") as log_analysis,
            patch(
                "optimization_service.repo.log_suggestions",
                return_value=["suggestion-1"],
            ) as log_suggestions,
        ):
            events = await collect_analysis(request(), graph=graph)

        self.assertEqual(
            [event["event"] for event in events],
            ["cost_ready", "suggestions_ready"],
        )
        for event in events:
            self.assertEqual(event["analysis_id"], "analysis-1")
            self.assertEqual(event["draft_version"], 3)
            self.assertEqual(event["prompt_hash"], prompt_hash("long prompt"))
        self.assertEqual(
            events[1]["suggestions"][0]["suggestion_id"], "suggestion-1"
        )
        log_analysis.assert_called_once()
        persisted = log_suggestions.call_args.args[1]
        self.assertEqual(persisted[0]["source_block_hashes"], ["selected-block"])
        self.assertNotIn("source_block_hashes", log_suggestions.call_args.kwargs)
        self.assertEqual(
            graph.config,
            {"configurable": {"thread_id": "optimization-1"}},
        )

    async def test_hash_mismatch_fails_without_invoking_graph(self) -> None:
        bad = request()
        bad["prompt_hash"] = prompt_hash("something else")
        graph = FakeGraph()

        events = await collect_analysis(bad, graph=graph)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "analysis_failed")
        self.assertIn("prompt_hash", events[0]["error"])
        self.assertFalse(hasattr(graph, "state"))

    async def test_valid_first_enter_is_logged_when_gate_fails_before_cost(
        self,
    ) -> None:
        with (
            patch("optimization_service.repo.log_draft_analysis") as log_analysis,
            patch("optimization_service.repo.record_decision") as record_decision,
        ):
            events = await collect_analysis(
                request(), graph=FailingBeforeCostGraph()
            )

        self.assertEqual([event["event"] for event in events], ["analysis_failed"])
        self.assertIsNone(log_analysis.call_args.args[0]["original_cost"])
        record_decision.assert_called_once_with("analysis-1", "failed", None)


if __name__ == "__main__":
    unittest.main()
