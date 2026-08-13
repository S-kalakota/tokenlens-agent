import io
import os
import unittest
from unittest.mock import MagicMock, patch

from db.backfill import read_records, replay_history
from db.blocks import fingerprint_prompt, upsert_block_fingerprints
from db.client import COLLECTION_NAMES
from db.indexes import INDEX_CONTRACTS, automated_embedding_definition
from db.profile import build_outcome_profile_update, profile_from_document
from db.repo import (
    find_similar,
    log_session,
    log_suggestions,
    record_outcome,
    refresh_profile_from_sessions,
)


class Result:
    def __init__(self, *, upserted_id=None, matched_count=1, modified_count=1):
        self.upserted_id = upserted_id
        self.matched_count = matched_count
        self.modified_count = modified_count


class BlockCollection:
    def __init__(self):
        self.documents = {}

    def update_one(self, query, update, upsert=False):
        key = (query["user_id"], query["project"], query["block_hash"])
        document = self.documents.setdefault(key, dict(query))
        if len(document) == 3:
            document.update(update.get("$setOnInsert", {}))
        document.update(update.get("$set", {}))
        for name, amount in update.get("$inc", {}).items():
            document[name] = document.get(name, 0) + amount
        return Result(upserted_id=key if upsert else None)

    def update_many(self, query, update, **kwargs):
        del kwargs
        hashes = set(query["block_hash"]["$in"])
        modified = 0
        for key, document in self.documents.items():
            if (
                key[0] == query["user_id"]
                and key[1] == query["project"]
                and key[2] in hashes
            ):
                for name, amount in update.get("$inc", {}).items():
                    document[name] = document.get(name, 0) + amount
                modified += 1
        return Result(modified_count=modified)


class MemoryCollection:
    def __init__(self):
        self.documents = {}

    def update_one(self, query, update, upsert=False, **kwargs):
        key = query.get("_id")
        existed = key in self.documents
        if not existed and upsert:
            self.documents[key] = dict(update.get("$setOnInsert", {}))
        return Result(upserted_id=None if existed else key)

    def find(self, query):
        user_id = query.get("user_id")
        return [
            item
            for item in self.documents.values()
            if user_id is None or item.get("user_id") == user_id
        ]

    def find_one(self, query):
        return self.documents.get(query.get("_id"))


class BackfillDatabase(dict):
    def __getitem__(self, name):
        if name not in self:
            self[name] = (
                BlockCollection()
                if name == "block_library"
                else MemoryCollection()
            )
        return super().__getitem__(name)


class DatabaseContractTests(unittest.TestCase):
    def test_all_seven_application_collections_and_required_indexes_exist(self):
        self.assertEqual(len(COLLECTION_NAMES), 7)
        names = {item["name"] for item in INDEX_CONTRACTS}
        self.assertIn("draft_analysis_identity", names)
        self.assertIn("draft_analyses_by_user_created", names)
        self.assertIn("suggestions_by_session_outcome", names)
        self.assertIn("suggestions_by_source_prompt_outcome", names)
        self.assertIn("block_library_identity", names)
        ttl = next(
            item
            for item in INDEX_CONTRACTS
            if item["name"] == "created_at_1"
        )
        self.assertEqual(ttl["expire_after_seconds"], 86_400)

    def test_automated_embedding_indexes_session_prompt_and_user_filter(self):
        definition = automated_embedding_definition()

        self.assertEqual(definition["fields"][0]["type"], "autoEmbed")
        self.assertEqual(definition["fields"][0]["path"], "prompt_text")
        self.assertIn({"type": "filter", "path": "user_id"}, definition["fields"])

    def test_repeated_prompt_increments_block_occurrences(self):
        collection = BlockCollection()
        lines = "\n".join(f"column {index}" for index in range(20))
        prompt = f"```sql\n{lines}\n```"

        upsert_block_fingerprints(collection, prompt, "user-1", "project-1")
        upsert_block_fingerprints(collection, prompt, "user-1", "project-1")

        self.assertTrue(collection.documents)
        self.assertTrue(
            all(
                item["occurrences"] == 2
                for item in collection.documents.values()
            )
        )

    def test_profile_pipeline_stores_counts_and_shrunk_rate(self):
        pipeline = build_outcome_profile_update(
            "dedupe",
            True,
            predicted_savings=100.0,
            actual_savings=80.0,
        )

        stage = pipeline[0]["$set"]
        self.assertIn("accept_rate_by_type.dedupe.accepted", stage)
        self.assertIn("accept_rate_by_type.dedupe.total", stage)
        self.assertIn("accept_rate_by_type.dedupe.rate", stage)
        self.assertIn("calibration.bias", stage)

    def test_outcome_calibration_is_optimism_and_updates_project(self):
        pipeline = build_outcome_profile_update(
            "dedupe",
            True,
            predicted_savings=100.0,
            actual_savings=80.0,
            project="alpha.beta",
        )

        global_bias = pipeline[0]["$set"]["calibration.bias"]
        project_key = "per_project.alpha\uff0ebeta.calibration.bias"
        project_bias = pipeline[1]["$set"][project_key]
        self.assertEqual(global_bias["$divide"][0]["$add"][1], 20.0)
        self.assertEqual(project_bias["$divide"][0]["$add"][1], 20.0)
        project_stage = pipeline[1]["$set"]
        self.assertIn(
            "per_project.alpha\uff0ebeta.cost_quantiles", project_stage
        )
        self.assertIn(
            "per_project.alpha\uff0ebeta.completion_ratio_median",
            project_stage,
        )

    def test_partial_legacy_project_profile_is_normalized(self):
        profile = profile_from_document(
            {
                "per_project": {
                    "alpha": {
                        "calibration": {"bias": 3.0, "mae": 4.0, "n": 2}
                    }
                }
            },
            "user-1",
        )

        project = profile["per_project"]["alpha"]
        self.assertEqual(project["cost_quantiles"]["n"], 0)
        self.assertEqual(project["completion_ratio_median"], 0.35)
        self.assertEqual(project["calibration"]["bias"], 3.0)

    def test_log_session_links_exact_analysis_and_refreshes_live_profile(self):
        sessions = MagicMock()
        suggestions = MagicMock()
        profiles = MagicMock()
        database = MagicMock()
        database.__getitem__.side_effect = {
            "sessions": sessions,
            "suggestions": suggestions,
            "user_profile": profiles,
        }.__getitem__
        ctx = {
            "user_id": "user-1",
            "session_id": "conversation-1",
            "project": "alpha",
            "target_model": "model-1",
            "session_turn_index": 3,
            "recent_costs": [],
            "completion_ratio_median": 0.35,
            "calibration_bias": 0.0,
        }

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("db.repo._database", return_value=database),
            patch("db.repo._new_id", return_value="session-document-1"),
            patch("db.repo.fingerprint_prompt", return_value=[]),
            patch("db.repo.refresh_profile_from_sessions") as refresh,
        ):
            document_id = log_session(
                "approved prompt",
                {"p10": 8.0, "p50": 10.0, "p90": 12.0},
                ctx,
                actual_cost=9.0,
                usage={
                    "input_tokens": 80,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 10,
                    "output_tokens": 25,
                },
                analysis_id="analysis-1",
            )

        self.assertEqual(document_id, "session-document-1")
        document = sessions.insert_one.call_args.args[0]
        self.assertEqual(document["analysis_id"], "analysis-1")
        self.assertEqual(document["completion_ratio"], 0.25)
        suggestions.update_many.assert_called_once_with(
            {
                "analysis_id": "analysis-1",
                "source_session_document_id": None,
            },
            {"$set": {"source_session_document_id": "session-document-1"}},
        )
        refresh.assert_called_once_with("user-1", database=database)

    def test_session_refresh_preserves_outcome_calibration(self):
        sessions = MagicMock()
        sessions.find.return_value = [
            {
                "project": "alpha.beta",
                "actual_cost": 8.0,
                "predicted_cost": {"p50": 10.0},
                "completion_ratio": 0.2,
            },
            {
                "project": "alpha.beta",
                "actual_cost": None,
                "predicted_cost": {"p50": 20.0},
                "usage": {"input_tokens": 40, "output_tokens": 20},
            },
            {
                "project": "other",
                "actual_cost": 30.0,
                "predicted_cost": {"p50": 32.0},
                "completion_ratio": 0.8,
            },
        ]
        profiles = MagicMock()
        profiles.find_one.return_value = {
            "_id": "user-1",
            "cost_quantiles": {
                "p40": 1.0,
                "p50": 1.0,
                "p90": 1.0,
                "n": 1,
            },
            "accept_rate_by_type": {
                "dedupe": {"rate": 0.75, "accepted": 3, "total": 4}
            },
            "calibration": {"bias": 7.0, "mae": 9.0, "n": 5},
            "per_project": {
                "alpha\uff0ebeta": {
                    "cost_quantiles": {
                        "p40": 1.0,
                        "p50": 1.0,
                        "p90": 1.0,
                        "n": 1,
                    },
                    "calibration": {"bias": 4.0, "mae": 6.0, "n": 2},
                    "completion_ratio_median": 0.1,
                }
            },
            "completion_ratio_median": 0.1,
        }
        database = {"sessions": sessions, "user_profile": profiles}

        profile = refresh_profile_from_sessions("user-1", database=database)

        self.assertEqual(profile["cost_quantiles"]["p50"], 20.0)
        self.assertEqual(profile["cost_quantiles"]["n"], 3)
        self.assertEqual(profile["completion_ratio_median"], 0.5)
        self.assertEqual(profile["calibration"]["bias"], 7.0)
        project = profile["per_project"]["alpha.beta"]
        self.assertEqual(project["cost_quantiles"]["p50"], 14.0)
        self.assertEqual(project["completion_ratio_median"], 0.35)
        self.assertEqual(project["calibration"]["bias"], 4.0)

        pipeline = profiles.update_one.call_args.args[1]
        self.assertEqual(
            pipeline[0]["$set"]["calibration"],
            {
                "$ifNull": [
                    "$calibration",
                    {"bias": 0.0, "mae": 0.0, "n": 0},
                ]
            },
        )
        nested = pipeline[1]["$set"]
        self.assertEqual(
            nested["per_project.alpha\uff0ebeta.calibration"]["$ifNull"][0],
            "$per_project.alpha\uff0ebeta.calibration",
        )

    def test_find_similar_joins_exact_source_turn_or_analysis(self):
        sessions = MagicMock()
        sessions.aggregate.return_value = []
        database = MagicMock()
        database.__getitem__.return_value = sessions

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("db.repo._database", return_value=database),
        ):
            self.assertEqual(find_similar("prompt", "user-1"), [])

        pipeline = sessions.aggregate.call_args.args[0]
        lookup = pipeline[2]["$lookup"]
        self.assertEqual(lookup["let"]["source_document_id"], "$_id")
        self.assertEqual(lookup["let"]["source_analysis_id"], "$analysis_id")
        expression = repr(lookup["pipeline"][0]["$match"]["$expr"])
        self.assertIn("$source_session_document_id", expression)
        self.assertIn("$$source_document_id", expression)
        self.assertIn("$$source_analysis_id", expression)
        self.assertNotIn("$$source_session_id", expression)

    def test_suggestions_persist_candidate_specific_block_provenance(self):
        sessions = MagicMock()
        sessions.find_one.return_value = {}
        suggestions = MagicMock()
        analyses = MagicMock()
        analyses.update_one.return_value = Result()
        database = MagicMock()
        database.__getitem__.side_effect = {
            "sessions": sessions,
            "suggestions": suggestions,
            "draft_analyses": analyses,
        }.__getitem__
        rewrites = [
            {
                "rewrite": "reuse selected block",
                "rationale": "known recurrence",
                "suggestion_type": "collapse_block",
                "source_block_hashes": ["selected"],
                "predicted_cost": {"p10": 10.0, "p50": 20.0, "p90": 30.0},
                "estimated_savings": 100.0,
            },
            {
                "rewrite": "trim text",
                "rationale": "remove repetition",
                "suggestion_type": "dedupe",
                "predicted_cost": {"p10": 20.0, "p50": 30.0, "p90": 40.0},
                "estimated_savings": 90.0,
            },
        ]

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("db.repo._database", return_value=database),
            patch(
                "db.repo._new_id",
                side_effect=["suggestion-one", "suggestion-two"],
            ),
        ):
            log_suggestions(
                "session-1",
                rewrites,
                user_id="user-1",
                analysis_id="analysis-1",
                source_block_hashes=["legacy-fallback"],
            )

        documents = suggestions.insert_many.call_args.args[0]
        self.assertEqual(documents[0]["source_block_hashes"], ["selected"])
        self.assertEqual(documents[0]["analysis_id"], "analysis-1")
        self.assertIsNone(documents[0]["source_session_document_id"])
        self.assertEqual(
            documents[1]["source_block_hashes"], ["legacy-fallback"]
        )

    def test_accepted_collapse_updates_only_its_generated_source_block(self):
        suggestions = MagicMock()
        suggestions.find_one.return_value = {
            "_id": "suggestion-one",
            "user_id": "user-1",
            "project": "project-1",
            "suggestion_type": "collapse_block",
            "predicted_savings": 120.0,
            "accepted": None,
            "source_block_hashes": ["removed-schema"],
        }
        suggestions.update_one.return_value = Result(matched_count=1)
        user_profile = MagicMock()
        block_library = MagicMock()
        database = MagicMock()
        database.__getitem__.side_effect = {
            "suggestions": suggestions,
            "user_profile": user_profile,
            "block_library": block_library,
        }.__getitem__
        session = MagicMock()
        database.client.start_session.return_value.__enter__.return_value = session

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("db.repo._database", return_value=database),
            patch("db.repo.apply_outcome_profile_update"),
            patch("db.repo.increment_collapse_acceptance") as increment,
        ):
            record_outcome("suggestion-one", True, 100.0)

        increment.assert_called_once_with(
            block_library,
            user_id="user-1",
            project="project-1",
            block_hashes=["removed-schema"],
            session=session,
        )

    def test_outcome_fails_before_writes_without_transaction_support(self):
        suggestions = MagicMock()
        suggestions.find_one.return_value = {
            "_id": "suggestion-one",
            "user_id": "user-1",
            "project": None,
            "suggestion_type": "dedupe",
            "predicted_savings": 120.0,
            "accepted": None,
        }
        database = MagicMock()
        database.__getitem__.return_value = suggestions
        database.client.start_session.side_effect = NotImplementedError

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}, clear=False),
            patch("db.repo._database", return_value=database),
            self.assertRaisesRegex(RuntimeError, "transaction-capable"),
        ):
            record_outcome("suggestion-one", True, 100.0)

        suggestions.update_one.assert_not_called()

    def test_json_and_jsonl_inputs_are_supported(self):
        json_records = list(read_records(io.StringIO('[{"prompt": "one"}]')))
        jsonl_records = list(
            read_records(io.StringIO('{"prompt": "one"}\n{"prompt": "two"}\n'))
        )

        self.assertEqual(len(json_records), 1)
        self.assertEqual(len(jsonl_records), 2)

    def test_backfill_is_idempotent(self):
        database = BackfillDatabase()
        records = [
            {
                "_id": "session-1",
                "user_id": "user-1",
                "session_id": "conversation-1",
                "prompt": "line\n" * 20,
                "predicted_cost": {"p10": 80, "p50": 100, "p90": 120},
                "actual_cost": 90,
            }
        ]
        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}),
            patch("db.backfill.refresh_profile_from_sessions", return_value={}),
        ):
            first = replay_history(records, database=database)
            second = replay_history(records, database=database)

        self.assertEqual(first["sessions"], 1)
        self.assertEqual(second["sessions"], 0)
        self.assertEqual(second["skipped"], 1)

    def test_backfill_replays_exact_collapse_acceptance_once(self):
        database = BackfillDatabase()
        body = "\n".join(f"column {index}" for index in range(20))
        prompt = f"```sql\n{body}\n```"
        block_hash = fingerprint_prompt(prompt)[0]["block_hash"]
        records = [
            {
                "_id": "session-collapse",
                "user_id": "user-1",
                "session_id": "conversation-1",
                "project": "alpha",
                "prompt": prompt,
                "predicted_cost": {"p10": 80, "p50": 100, "p90": 120},
                "suggestions": [
                    {
                        "suggestion_id": "suggestion-collapse",
                        "suggestion_type": "collapse_block",
                        "accepted": True,
                        "predicted_savings": 30,
                        "actual_savings": 25,
                        "source_block_hashes": [block_hash],
                    }
                ],
            }
        ]

        with (
            patch.dict(os.environ, {"TOKENLENS_STUB": "0"}),
            patch("db.backfill.apply_outcome_profile_update"),
            patch("db.backfill.refresh_profile_from_sessions", return_value={}),
        ):
            first = replay_history(records, database=database)
            second = replay_history(records, database=database)

        block = database["block_library"].documents[
            ("user-1", "alpha", block_hash)
        ]
        self.assertEqual(first["suggestions"], 1)
        self.assertEqual(second["suggestions"], 0)
        self.assertEqual(block["collapse_accepted"], 1)


if __name__ == "__main__":
    unittest.main()
