"""Historical TokenLens replay boundary.

The executable backfill is an Agent B deliverable in Part 3. This module
exists in Phase 0 so callers can depend on its stable entry point.
"""

from collections.abc import Iterable, Mapping
from typing import Any


def replay_history(records: Iterable[Mapping[str, Any]]) -> None:
    """Replay raw history into episodic and derived Mongo collections."""

    del records
    raise NotImplementedError("Backfill is implemented in Part 3 (Agent B)")


def main() -> int:
    raise NotImplementedError("Backfill is implemented in Part 3 (Agent B)")


if __name__ == "__main__":
    raise SystemExit(main())
