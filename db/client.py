"""MongoDB client boundary.

``pymongo`` is intentionally imported only when a real database connection is
requested.  Stub mode and unit tests therefore keep working in environments
that do not have the optional production dependencies installed.
"""

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

DEFAULT_DATABASE_NAME = "tokenlens"
COLLECTION_NAMES: tuple[str, ...] = (
    "draft_analyses",
    "sessions",
    "prompt_embeddings",
    "suggestions",
    "user_profile",
    "block_library",
    "checkpoints",
)


@dataclass(frozen=True)
class MongoSettings:
    uri: str
    database_name: str = DEFAULT_DATABASE_NAME

    @classmethod
    def from_environment(cls) -> "MongoSettings":
        uri = os.getenv("MONGODB_URI", "").strip()
        if not uri:
            raise RuntimeError("MONGODB_URI is required outside stub mode")
        database_name = (
            os.getenv("MONGODB_DATABASE", DEFAULT_DATABASE_NAME).strip()
            or DEFAULT_DATABASE_NAME
        )
        return cls(uri=uri, database_name=database_name)


def get_client(settings: MongoSettings | None = None) -> Any:
    """Return a process-wide client for the selected URI.

    The settings dataclass is hashable, so the cache also behaves sensibly in
    tests that exercise more than one URI.  No connection is made eagerly by
    PyMongo; the first database operation performs server selection.
    """

    resolved = settings or MongoSettings.from_environment()
    return _cached_client(resolved)


@lru_cache(maxsize=4)
def _cached_client(settings: MongoSettings) -> Any:
    try:
        from pymongo import MongoClient
    except ImportError as exc:  # pragma: no cover - depends on local extras
        raise RuntimeError(
            "Real MongoDB access requires the optional 'pymongo' package"
        ) from exc

    return MongoClient(
        settings.uri,
        appname="tokenlens-agent",
        tz_aware=True,
        connect=False,
    )


def get_database(settings: MongoSettings | None = None) -> Any:
    """Return the configured database from the cached process client."""

    resolved = settings or MongoSettings.from_environment()
    return get_client(resolved)[resolved.database_name]


def ensure_collections(database: Any | None = None) -> tuple[str, ...]:
    """Create all application collections that do not already exist.

    ``checkpoints`` is still owned by ``MongoDBSaver`` after creation; creating
    the collection here merely allows its TTL index to be installed up front.
    """

    selected = database if database is not None else get_database()
    existing = set(selected.list_collection_names())
    for name in COLLECTION_NAMES:
        if name not in existing:
            selected.create_collection(name)
    return COLLECTION_NAMES


def close_cached_clients() -> None:
    """Close and forget cached clients (primarily useful to test harnesses)."""

    # functools does not expose cached values.  Clearing is sufficient for
    # normal process shutdown; callers that own explicit clients should close
    # those clients directly.
    _cached_client.cache_clear()
