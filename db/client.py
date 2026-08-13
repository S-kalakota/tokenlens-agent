"""MongoDB client boundary.

No module outside ``db`` may construct or query a Mongo client.
"""

import os
from dataclasses import dataclass
from typing import Any


DEFAULT_DATABASE_NAME = "tokenlens"
COLLECTION_NAMES: tuple[str, ...] = (
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
    """Return the process-wide Mongo client.

    Client construction and caching belong to Part 3 (Agent B). Keeping the
    import lazy there will let Phase 0 run without PyMongo installed.
    """

    del settings
    raise NotImplementedError("MongoDB client setup is implemented in Part 3 (Agent B)")
