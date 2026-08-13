"""Terminal rendering kept separate from composer transitions."""

from collections.abc import Callable, Sequence
from typing import Any

from contracts import CostBand, ScoredRewrite

Output = Callable[[str], None]


class Renderer:
    def __init__(self, output: Output = print) -> None:
        self.output = output

    def cost_ready(self, cost: CostBand) -> None:
        self.output(f"Original estimate: {cost['p50']:,.0f} tokens")
        self.output("Analyzing history…")

    def suggestions(
        self,
        rewrites: Sequence[ScoredRewrite],
        original_cost: CostBand | None,
    ) -> None:
        self.output("")
        for index, rewrite in enumerate(rewrites, start=1):
            candidate_cost = rewrite["predicted_cost"]["p50"]
            savings = rewrite["estimated_savings"]
            baseline = original_cost["p50"] if original_cost else 0.0
            percentage = 0.0 if baseline <= 0 else savings / baseline * 100
            self.output(
                f"[{index}] {candidate_cost:,.0f} tokens  "
                f"Save {savings:,.0f} ({percentage:.0f}%)  "
                f"{rewrite['rationale']}"
            )
            self.output(rewrite["rewrite"])
        self.output("[S] Skip and keep original")

    def ready(self, *, optimized: bool, selected_prompt: str | None = None) -> None:
        choice = "optimized" if optimized else "original"
        if selected_prompt is not None:
            self.output(f"Selected prompt:\n{selected_prompt}")
        self.output(
            f"Ready to send {choice} prompt. "
            "Press Enter to send; editing restarts analysis."
        )

    def error(self, message: str) -> None:
        self.output(f"TokenLens error: {message}")

    def claude_event(self, event: dict[str, Any]) -> None:
        """Render incremental Claude text without dumping protocol metadata."""

        if event.get("type") != "stream_event":
            return
        nested = event.get("event")
        if not isinstance(nested, dict) or nested.get("type") != "content_block_delta":
            return
        delta = nested.get("delta")
        if not isinstance(delta, dict):
            return
        text = delta.get("text")
        if isinstance(text, str) and text:
            self.output(text)
