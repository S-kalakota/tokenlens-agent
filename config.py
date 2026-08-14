"""Dependency-free configuration shared by every TokenLens entry point."""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
STUB_FIXTURE_PATH = PROJECT_ROOT / "fixtures" / "stub_data.json"
_TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})


def load_environment(path: Path | None = None) -> None:
    """Load simple ``KEY=value`` pairs without overriding the parent process.

    Keeping this tiny avoids making the MCP server or CLI depend on
    ``python-dotenv`` merely to honor the repository's ignored ``.env`` file.
    Quoted values and ``export KEY=...`` are supported; shell expansion is
    intentionally not performed.
    """

    environment_path = path or PROJECT_ROOT / ".env"
    if not environment_path.is_file():
        return
    for raw_line in environment_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or not key.replace("_", "A").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in _TRUTHY_VALUES


def env_float(name: str, default: float) -> float:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


def stub_enabled() -> bool:
    """Return whether fixture-backed implementations should be used."""

    return env_bool("TOKENLENS_STUB")


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


load_environment()
