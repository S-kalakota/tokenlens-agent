import os
import time
import unittest
from copy import deepcopy
from unittest.mock import patch

import model.predictor as predictor
from contracts import PredictionContext
from model.featurizer import FEATURE_ORDER, build_feature_row, build_feature_vector


def prediction_context(**overrides: object) -> PredictionContext:
    context: PredictionContext = {
        "user_id": "user-1",
        "session_id": "session-1",
        "project": "tokenlens",
        "target_model": "openai/gpt-4.1",
        "session_turn_index": 4,
        "recent_costs": [600.0, 900.0, 1200.0],
        "completion_ratio_median": 0.35,
        "calibration_bias": 0.0,
    }
    context.update(overrides)  # type: ignore[typeddict-item]
    return context


class CapturingBooster:
    def __init__(self, *, point_predictions: bool = False) -> None:
        self.calls: list[list[list[float]]] = []
        self.point_predictions = point_predictions

    def num_feature(self) -> int:
        return len(FEATURE_ORDER)

    def feature_name(self) -> list[str]:
        return list(FEATURE_ORDER)

    def predict(self, matrix: list[list[float]]) -> list[object]:
        self.calls.append(deepcopy(matrix))
        estimates = [row[0] + row[4] * 100.0 for row in matrix]
        if self.point_predictions:
            return estimates
        return [[estimate * 0.8, estimate, estimate * 1.25] for estimate in estimates]


class FeatureExtractionTests(unittest.TestCase):
    def test_features_include_structure_context_and_identical_imputation(self) -> None:
        context = prediction_context()
        prompt = """Inspect src/api/client.py and ./tests/test_api.py.
```python
same = 1
same = 1
```
"""

        row = build_feature_row(prompt, context)
        first = build_feature_vector(prompt, context)
        second = build_feature_vector(prompt, context)

        self.assertEqual(first, second)
        self.assertEqual(tuple(row), FEATURE_ORDER)
        self.assertEqual(row["completion_ratio"], 0.35)
        self.assertEqual(row["fenced_block_count"], 1)
        self.assertGreater(row["duplicate_line_ratio"], 0.0)
        self.assertGreater(row["repeated_block_token_share"], 0.0)
        self.assertGreater(row["path_token_count"], 0)

    def test_feature_extraction_does_not_mutate_context(self) -> None:
        context = prediction_context()
        before = deepcopy(context)

        build_feature_row("Inspect src/main.py", context)

        self.assertEqual(context, before)


class PredictorTests(unittest.TestCase):
    def real_environment(self) -> patch.dict[str, str]:
        return patch.dict(
            os.environ,
            {"TOKENLENS_STUB": "0", predictor.HEURISTIC_FALLBACK_ENV: ""},
            clear=False,
        )

    def test_stub_mode_preserves_committed_fixture_and_skips_booster(self) -> None:
        booster = CapturingBooster()
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False), patch.object(
            predictor, "_BOOSTER", booster
        ):
            single = predictor.predict("one", prediction_context())
            batch = predictor.predict_many(["one", "two"], prediction_context())

        self.assertEqual(single, {"p10": 980.0, "p50": 1280.0, "p90": 1660.0})
        self.assertEqual(batch, [single, single])
        self.assertIsNot(batch[0], batch[1])
        self.assertEqual(booster.calls, [])

    def test_stub_mode_is_deterministic_and_prompt_sensitive(self) -> None:
        block = "\n".join(f"generated declaration {index}" for index in range(200))
        shorter = f"Review these declarations:\n{block}"
        duplicated = f"Review these declarations:\n{block}\n{block}"
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False):
            first = predictor.predict(duplicated, prediction_context())
            second = predictor.predict(duplicated, prediction_context())
            rewrite = predictor.predict(shorter, prediction_context())

        self.assertEqual(first, second)
        self.assertGreater(first["p50"], rewrite["p50"])

    def test_stub_run_local_returns_ranked_positive_savings(self) -> None:
        from scripts.run_local import run

        prompt = "\n".join(
            [
                "Analyze this generated project inventory and suggest a repair.",
                *(
                    f"src/generated/module_{index}/declaration.py"
                    for index in range(120)
                ),
            ]
        )
        with patch.dict(os.environ, {"TOKENLENS_STUB": "1"}, clear=False):
            result = run(prompt, "stub-model-integration")

        self.assertTrue(result["suggestions"])
        self.assertTrue(
            all(item["estimated_savings"] > 0 for item in result["suggestions"])
        )

    def test_predict_many_is_one_real_batch_call(self) -> None:
        booster = CapturingBooster()
        prompts = ["first prompt", "second prompt", "third prompt"]
        with self.real_environment(), patch.object(predictor, "_BOOSTER", booster):
            results = predictor.predict_many(prompts, prediction_context())

        self.assertEqual(len(results), 3)
        self.assertEqual(len(booster.calls), 1)
        self.assertEqual(len(booster.calls[0]), 3)

    def test_single_and_batch_entry_points_build_identical_vectors(self) -> None:
        booster = CapturingBooster()
        context = prediction_context()
        prompt = "Keep exactly the same frozen context"
        with self.real_environment(), patch.object(predictor, "_BOOSTER", booster):
            predictor.predict(prompt, context)
            predictor.predict_many([prompt, "another candidate"], context)

        self.assertEqual(booster.calls[0][0], booster.calls[1][0])
        self.assertEqual(
            booster.calls[0][0],
            list(build_feature_vector(prompt, context)),
        )

    def test_calibration_bias_is_applied_after_booster_prediction(self) -> None:
        booster = CapturingBooster()
        unbiased = prediction_context(calibration_bias=0.0)
        corrected = prediction_context(calibration_bias=12.5)
        with self.real_environment(), patch.object(predictor, "_BOOSTER", booster):
            base = predictor.predict("a prompt long enough to score", unbiased)
            calibrated = predictor.predict("a prompt long enough to score", corrected)

        self.assertAlmostEqual(calibrated["p10"], base["p10"] + 12.5)
        self.assertAlmostEqual(calibrated["p50"], base["p50"] + 12.5)
        self.assertAlmostEqual(calibrated["p90"], base["p90"] + 12.5)

    def test_explicit_heuristic_scores_duplicate_200_line_block_higher(self) -> None:
        block = "\n".join(
            f"unique generated declaration number {index}" for index in range(200)
        )
        deduplicated = f"Analyze this generated output:\n{block}"
        duplicated = f"Analyze this generated output:\n{block}\n{block}"
        environment = {
            "TOKENLENS_STUB": "0",
            predictor.HEURISTIC_FALLBACK_ENV: "heuristic",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            predictor, "_BOOSTER", None
        ):
            original = predictor.predict(duplicated, prediction_context())
            rewrite = predictor.predict(deduplicated, prediction_context())

        self.assertGreater(original["p50"], rewrite["p50"])
        self.assertGreater(
            build_feature_row(duplicated, prediction_context())[
                "repeated_block_token_share"
            ],
            build_feature_row(deduplicated, prediction_context())[
                "repeated_block_token_share"
            ],
        )

    def test_missing_real_model_fails_explicitly(self) -> None:
        with self.real_environment(), patch.object(
            predictor, "_BOOSTER", None
        ), patch.object(
            predictor, "_BOOSTER_UNAVAILABLE_REASON", "test artifact is unavailable"
        ):
            with self.assertRaisesRegex(
                predictor.PredictorUnavailableError,
                "test artifact is unavailable",
            ):
                predictor.predict("do not fake this score", prediction_context())

    def test_warm_prediction_returns_under_fifty_milliseconds(self) -> None:
        block = "\n".join(f"line {index}" for index in range(200))
        prompt = f"{block}\n{block}"
        environment = {
            "TOKENLENS_STUB": "0",
            predictor.HEURISTIC_FALLBACK_ENV: "heuristic",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            predictor, "_BOOSTER", None
        ):
            predictor.predict(prompt, prediction_context())  # warm caches/imports
            started = time.perf_counter()
            predictor.predict(prompt, prediction_context())
            elapsed = time.perf_counter() - started

        self.assertLess(elapsed, 0.050)


if __name__ == "__main__":
    unittest.main()
