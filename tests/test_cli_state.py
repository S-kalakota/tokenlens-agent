import unittest

from cli.renderer import Renderer
from cli.state import (
    ComposerTransitionError,
    accept_suggestion,
    apply_analysis_event,
    begin_analysis,
    edit_draft,
    new_composer_state,
    prepare_send,
    prompt_hash,
    send_failed,
    skip_optimization,
)


def reviewed_state():
    state = new_composer_state()
    state = edit_draft(state, "original π prompt\n")
    state = begin_analysis(state, analysis_id="analysis-1")
    state = apply_analysis_event(
        state,
        {
            "event": "cost_ready",
            "analysis_id": "analysis-1",
            "draft_version": state["draft_version"],
            "prompt_hash": state["analyzed_prompt_hash"],
            "cost": {"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
        },
    )
    return apply_analysis_event(
        state,
        {
            "event": "suggestions_ready",
            "analysis_id": "analysis-1",
            "draft_version": state["draft_version"],
            "prompt_hash": state["analyzed_prompt_hash"],
            "route": "full",
            "suggestions": [
                {
                    "suggestion_id": "suggestion-1",
                    "rewrite": "short π prompt",
                    "rationale": "Remove repetition",
                    "suggestion_type": "dedupe",
                    "predicted_cost": {
                        "p10": 400.0,
                        "p50": 500.0,
                        "p90": 600.0,
                    },
                    "estimated_savings": 500.0,
                }
            ],
        },
    )


class ComposerStateTests(unittest.TestCase):
    def test_hashes_exact_utf8_bytes(self) -> None:
        self.assertNotEqual(prompt_hash("π\n"), prompt_hash("π"))
        self.assertEqual(len(prompt_hash("π")), 64)

    def test_first_enter_never_grants_send_permission(self) -> None:
        state = edit_draft(new_composer_state(), "do the work")
        analyzing = begin_analysis(state, analysis_id="a")

        self.assertEqual(analyzing["phase"], "analyzing")
        with self.assertRaises(ComposerTransitionError):
            prepare_send(analyzing)

    def test_accept_and_skip_each_create_a_frozen_ready_selection(self) -> None:
        review = reviewed_state()

        accepted = accept_suggestion(review, 0)
        skipped = skip_optimization(review)

        self.assertEqual(accepted["phase"], "ready")
        self.assertEqual(accepted["draft_text"], "short π prompt")
        self.assertEqual(accepted["decision"], "accepted")
        self.assertEqual(skipped["draft_text"], "original π prompt\n")
        self.assertEqual(skipped["decision"], "skipped")
        self.assertEqual(prepare_send(accepted)["phase"], "sending")
        self.assertEqual(prepare_send(skipped)["phase"], "sending")

    def test_edit_in_review_or_ready_revokes_permission(self) -> None:
        review = reviewed_state()
        ready = accept_suggestion(review, 0)

        for state in (review, ready):
            edited = edit_draft(state, state["draft_text"] + " changed")
            self.assertEqual(edited["phase"], "draft")
            self.assertIsNone(edited["analysis_id"])
            self.assertIsNone(edited["decision"])
            with self.assertRaises(ComposerTransitionError):
                prepare_send(edited)

    def test_stale_event_cannot_repaint_current_draft(self) -> None:
        state = edit_draft(new_composer_state(), "new prompt")
        state = begin_analysis(state, analysis_id="new-analysis")
        stale = {
            "event": "suggestions_ready",
            "analysis_id": "old-analysis",
            "draft_version": state["draft_version"],
            "prompt_hash": state["analyzed_prompt_hash"],
            "route": "full",
            "suggestions": [],
        }

        self.assertEqual(apply_analysis_event(state, stale), state)

    def test_visible_hash_is_checked_again_immediately_before_send(self) -> None:
        ready = accept_suggestion(reviewed_state(), 0)
        tampered = {**ready, "draft_text": "different"}

        with self.assertRaises(ComposerTransitionError):
            prepare_send(tampered)

    def test_failed_send_returns_to_ready_for_explicit_retry(self) -> None:
        sending = prepare_send(accept_suggestion(reviewed_state(), 0))
        ready = send_failed(sending, "transport failed")
        retry = prepare_send(ready)

        self.assertEqual(ready["phase"], "ready")
        self.assertEqual(ready["last_error"], "transport failed")
        self.assertIsNotNone(sending["send_attempt_id"])
        self.assertNotEqual(
            retry["send_attempt_id"],
            sending["send_attempt_id"],
        )


class RendererTests(unittest.TestCase):
    def test_review_and_ready_render_the_actual_selected_text(self) -> None:
        lines: list[str] = []
        renderer = Renderer(lines.append)
        renderer.suggestions(
            [
                {
                    "rewrite": "the shorter approved prompt",
                    "rationale": "Remove repeated context",
                    "suggestion_type": "dedupe",
                    "predicted_cost": {
                        "p10": 300.0,
                        "p50": 400.0,
                        "p90": 500.0,
                    },
                    "estimated_savings": 600.0,
                }
            ],
            {"p10": 800.0, "p50": 1000.0, "p90": 1200.0},
        )
        renderer.ready(
            optimized=True,
            selected_prompt="the shorter approved prompt",
        )

        rendered = "\n".join(lines)
        self.assertIn("the shorter approved prompt", rendered)
        self.assertIn("Ready to send optimized prompt", rendered)


if __name__ == "__main__":
    unittest.main()
