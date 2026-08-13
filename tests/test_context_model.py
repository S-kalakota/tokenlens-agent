import unittest

from db.blocks import fingerprint_prompt, hash_block, normalize_block
from db.profile import empty_profile, shrunk_acceptance_stats


class BlockFingerprintTests(unittest.TestCase):
    def test_whitespace_variants_have_the_same_hash(self) -> None:
        first = normalize_block("CREATE   TABLE example (\n id bigint\n)")
        second = normalize_block(" CREATE TABLE example ( id bigint ) ")

        self.assertEqual(first, second)
        self.assertEqual(hash_block(first), hash_block(second))

    def test_fenced_blocks_include_source_lines(self) -> None:
        prompt = "\n".join(
            [
                "Inspect this:",
                "```sql",
                "CREATE TABLE example (",
                "",
                "  id bigint",
                "```",
            ]
        )

        fingerprints = fingerprint_prompt(prompt)
        fenced = [
            fingerprint
            for fingerprint in fingerprints
            if fingerprint["kind"] == "fenced_code"
        ]

        self.assertEqual(len(fenced), 1)
        self.assertEqual(fenced[0]["start_line"], 3)
        self.assertEqual(fenced[0]["end_line"], 5)
        self.assertGreater(fenced[0]["token_count"], 0)

    def test_every_twenty_line_sliding_window_is_hashed(self) -> None:
        prompt = "\n".join(f"line {index}" for index in range(1, 22))
        windows = [
            fingerprint
            for fingerprint in fingerprint_prompt(prompt)
            if fingerprint["kind"] == "line_window"
        ]

        self.assertEqual(len(windows), 2)
        self.assertEqual((windows[0]["start_line"], windows[0]["end_line"]), (1, 20))
        self.assertEqual((windows[1]["start_line"], windows[1]["end_line"]), (2, 21))


class ProfileTests(unittest.TestCase):
    def test_sparse_acceptance_is_shrunk_toward_prior(self) -> None:
        stats = shrunk_acceptance_stats(accepted=2, total=2)

        self.assertEqual(stats["accepted"], 2)
        self.assertEqual(stats["total"], 2)
        self.assertGreater(stats["rate"], 0.35)
        self.assertLess(stats["rate"], 1.0)

    def test_mature_acceptance_uses_observed_rate(self) -> None:
        stats = shrunk_acceptance_stats(accepted=7, total=10)

        self.assertEqual(stats["rate"], 0.7)

    def test_empty_profile_preserves_cold_start_counts(self) -> None:
        profile = empty_profile("user-1")

        self.assertEqual(profile["user_id"], "user-1")
        self.assertEqual(profile["cost_quantiles"]["n"], 0)
        self.assertEqual(profile["accept_rate_by_type"], {})
        self.assertEqual(profile["calibration"]["bias"], 0.0)


if __name__ == "__main__":
    unittest.main()
