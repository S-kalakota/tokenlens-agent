"""Declarative index contracts; Atlas creation is deferred to Part 3."""

from typing import Any, Literal, TypedDict


class IndexContract(TypedDict):
    name: str
    collection: str
    keys: tuple[tuple[str, int], ...]
    unique: bool
    expire_after_seconds: int | None


class VectorIndexContract(TypedDict):
    name: str
    collection: str
    source_collection: str
    source_field: str
    filter_fields: tuple[str, ...]
    embedding_mode: Literal["automated"]


INDEX_CONTRACTS: tuple[IndexContract, ...] = (
    {
        "name": "suggestions_by_session_outcome",
        "collection": "suggestions",
        "keys": (
            ("session_id", 1),
            ("accepted", 1),
            ("actual_savings", -1),
        ),
        "unique": False,
        "expire_after_seconds": None,
    },
    {
        "name": "block_library_identity",
        "collection": "block_library",
        "keys": (("user_id", 1), ("project", 1), ("block_hash", 1)),
        "unique": True,
        "expire_after_seconds": None,
    },
    {
        "name": "checkpoints_ttl",
        "collection": "checkpoints",
        "keys": (("created_at", 1),),
        "unique": False,
        "expire_after_seconds": 86_400,
    },
)

VECTOR_INDEX_CONTRACT: VectorIndexContract = {
    "name": "prompt_semantic_memory",
    "collection": "prompt_embeddings",
    "source_collection": "sessions",
    "source_field": "prompt_text",
    "filter_fields": ("user_id",),
    "embedding_mode": "automated",
}


def ensure_indexes(*args: Any, **kwargs: Any) -> None:
    """Create the declared MongoDB and Atlas vector indexes."""

    del args, kwargs
    raise NotImplementedError("Index creation is implemented in Part 3 (Agent B)")
