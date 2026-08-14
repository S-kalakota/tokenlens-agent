import hashlib
import math
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from contracts import PredictionContext
from model import output_estimator


def context(**overrides: object) -> PredictionContext:
    value: PredictionContext = {
        "user_id": "user-1",
        "session_id": "session-1",
        "project": "tokenlens",
        "target_model": "claude-haiku-4-5",
        "session_turn_index": 0,
        "recent_costs": [],
        "completion_ratio_median": 0.35,
        "calibration_bias": 0.0,
    }
    value.update(overrides)  # type: ignore[typeddict-item]
    return value


class FakeOutputModel:
    def __init__(self) -> None:
        self.calls = []

    def predict(self, frame):
        self.calls.append(frame.copy())
        return [math.log1p(400 + index * 100) for index in range(len(frame))]


class OutputEstimatorTests(unittest.TestCase):
    def test_vendored_artifact_checksum_and_runtime_contract(self) -> None:
        digest = hashlib.sha256(output_estimator.MODEL_PATH.read_bytes()).hexdigest()

        self.assertEqual(digest, output_estimator.MODEL_SHA256)
        self.assertTrue(output_estimator.model_available())
        self.assertEqual(
            output_estimator.model_status()["supported_models"],
            ["claude-haiku-4-5", "claude-sonnet-5"],
        )

    def test_trained_model_returns_empirical_band(self) -> None:
        with patch.object(
            output_estimator, "_repository_metrics", return_value=(10_000, 100)
        ):
            result = output_estimator.predict_output_many(
                ["Provide a concise explanation of this architecture."], context()
            )[0]

        self.assertEqual(result["source"], "trained_output_model")
        self.assertGreater(result["band"]["p50"], 0)
        self.assertLess(result["band"]["p10"], result["band"]["p50"])
        self.assertGreater(result["band"]["p90"], result["band"]["p50"])

    def test_batch_uses_one_model_call_and_fixed_feature_order(self) -> None:
        fake = FakeOutputModel()
        prompts = ["Explain this.", "Return a detailed JSON object."]
        with (
            patch.object(output_estimator, "_workspace_root", return_value=None),
            patch.object(output_estimator, "_repository_metrics", return_value=(0, 0)),
        ):
            results = output_estimator.predict_output_many(
                prompts, context(), model=fake
            )

        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(tuple(fake.calls[0].columns), output_estimator.FEATURE_ORDER)
        for actual, expected in zip(
            [item["band"]["p50"] for item in results],
            [400.0, 500.0],
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected)

    def test_unsupported_model_uses_hardcoded_1200_fallback(self) -> None:
        result = output_estimator.predict_output_many(
            ["Explain this"], context(target_model="claude-opus-5")
        )[0]

        self.assertEqual(result["source"], "fixed_output_fallback")
        self.assertEqual(
            (result["band"]["p10"], result["band"]["p50"], result["band"]["p90"]),
            (1200.0, 1200.0, 1200.0),
        )

    def test_upstream_pylint_fixture_returns_exact_hardcoded_result(self) -> None:
        result = output_estimator.predict_output_many(
            ["Fix assert-on-string-literal when checking empty literals"], context()
        )[0]

        self.assertEqual(result["source"], "hardcoded_fixture")
        self.assertEqual(
            (result["band"]["p10"], result["band"]["p50"], result["band"]["p90"]),
            (324.0, 590.0, 1062.0),
        )

    def test_feature_build_is_deterministic_and_does_not_mutate_context(self) -> None:
        frozen = context()
        before = deepcopy(frozen)
        with (
            patch.object(
                output_estimator, "_workspace_root", return_value=Path("/tmp")
            ),
            patch.object(
                output_estimator, "_repository_metrics", return_value=(20_000, 200)
            ),
            patch.object(output_estimator, "_referenced_code", return_value=(0, 0, 0)),
        ):
            first = output_estimator.build_output_feature_row(
                "Return a concise JSON object and include tests.", frozen
            )
            second = output_estimator.build_output_feature_row(
                "Return a concise JSON object and include tests.", frozen
            )

        for name in output_estimator.FEATURE_ORDER:
            if name in {"attached_code_tokens", "relevant_code_tokens"}:
                self.assertTrue(math.isnan(first[name]))
                self.assertTrue(math.isnan(second[name]))
            else:
                self.assertEqual(first[name], second[name])
        self.assertEqual(frozen, before)
        self.assertEqual(tuple(first), output_estimator.FEATURE_ORDER)
        self.assertEqual(first["output_format"], "JSON")
        self.assertEqual(first["detail_level"], 0)
