"""Small, dependency-free configuration helpers used by Phase 0 stubs."""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
STUB_FIXTURE_PATH = PROJECT_ROOT / "fixtures" / "stub_data.json"
_TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})


def stub_enabled() -> bool:
    """Return whether fixture-backed implementations should be used."""

    return os.getenv("TOKENLENS_STUB", "").strip().lower() in _TRUTHY_VALUES


@lru_cache(maxsize=1)
def load_stub_data() -> dict[str, Any]:
    """Load the committed fixture once and return its parsed data."""

    with STUB_FIXTURE_PATH.open(encoding="utf-8") as fixture_file:
        data = json.load(fixture_file)
    if not isinstance(data, dict):
        raise ValueError(f"Stub fixture must contain an object: {STUB_FIXTURE_PATH}")
    return data


def require_stub(component: str) -> None:
    """Fail clearly when a Phase 3 implementation has not landed yet."""

    if not stub_enabled():
        raise NotImplementedError(
            f"{component} is a Phase 3 implementation. "
            "Set TOKENLENS_STUB=1 to use the committed Phase 0 fixture."
        )
