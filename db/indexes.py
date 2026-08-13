"""Declarative MongoDB and Automated Embedding index contracts."""

import os
from typing import Any, Literal, TypedDict

from db.client import ensure_collections, get_database


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
    model: str


INDEX_CONTRACTS: tuple[IndexContract, ...] = (
    {
        "name": "draft_analysis_identity",
        "collection": "draft_analyses",
        "keys": (("analysis_id", 1),),
        "unique": True,
        "expire_after_seconds": None,
    },
    {
        "name": "draft_analyses_by_user_created",
        "collection": "draft_analyses",
        "keys": (("user_id", 1), ("created_at", -1)),
        "unique": False,
        "expire_after_seconds": None,
    },
    {
        "name": "sessions_by_user_created",
        "collection": "sessions",
        "keys": (("user_id", 1), ("timestamp", -1)),
        "unique": False,
        "expire_after_seconds": None,
    },
    {
        "name": "sessions_by_conversation_turn",
        "collection": "sessions",
        "keys": (("user_id", 1), ("session_id", 1), ("turn_index", 1)),
        "unique": False,
        "expire_after_seconds": None,
    },
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
        "name": "suggestions_by_source_prompt_outcome",
        "collection": "suggestions",
        "keys": (
            ("source_session_document_id", 1),
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
        # Keep PyMongo's default name. MongoDBSaver currently re-checks this
        # key with a list/tuple comparison that misses an existing custom-named
        # index, then asks MongoDB to create ``created_at_1`` itself. Using the
        # same deterministic name makes that repeated create idempotent.
        "name": "created_at_1",
        "collection": "checkpoints",
        "keys": (("created_at", 1),),
        "unique": False,
        "expire_after_seconds": 86_400,
    },
)

VECTOR_INDEX_CONTRACT: VectorIndexContract = {
    "name": "prompt_semantic_memory",
    # Automated Embedding indexes the source text in place.  MongoDB owns its
    # generated embedding collection; ``prompt_embeddings`` remains declared
    # for compatibility/inspection and is never populated by application code.
    "collection": "sessions",
    "source_collection": "sessions",
    "source_field": "prompt_text",
    "filter_fields": ("user_id",),
    "embedding_mode": "automated",
    "model": "voyage-4-lite",
}


def automated_embedding_definition(
    contract: VectorIndexContract = VECTOR_INDEX_CONTRACT,
) -> dict[str, Any]:
    """Return the Atlas Vector Search Automated Embedding definition."""

    model = os.getenv("TOKENLENS_EMBEDDING_MODEL", contract["model"]).strip()
    if not model:
        raise ValueError("TOKENLENS_EMBEDDING_MODEL must be non-empty")
    fields: list[dict[str, str]] = [
        {
            "type": "autoEmbed",
            "modality": "text",
            "path": contract["source_field"],
            "model": model,
        }
    ]
    fields.extend(
        {"type": "filter", "path": field}
        for field in contract["filter_fields"]
    )
    return {"fields": fields}


def _create_vector_index(database: Any) -> None:
    contract = VECTOR_INDEX_CONTRACT
    collection = database[contract["collection"]]

    # Avoid a noisy create command on every startup when the driver/server
    # supports listing search indexes.  Older test doubles may not expose it.
    existing_names: set[str] = set()
    try:
        existing_names = {
            item.get("name", "")
            for item in collection.aggregate([{"$listSearchIndexes": {}}])
        }
    except (AttributeError, NotImplementedError):
        pass
    if contract["name"] in existing_names:
        return

    command = {
        "createSearchIndexes": contract["collection"],
        "indexes": [
            {
                "name": contract["name"],
                "type": "vectorSearch",
                "definition": automated_embedding_definition(contract),
            }
        ],
    }
    try:
        database.command(command)
    except Exception as exc:
        # Index creation is idempotent at the application boundary.  Atlas can
        # report an existing definition with an IndexKeySpecsConflict-family
        # code during concurrent startup.
        if getattr(exc, "code", None) not in {68, 85, 86}:
            raise


def ensure_indexes(
    database: Any | None = None,
    *,
    include_vector: bool = True,
) -> tuple[str, ...]:
    """Create every collection and index, returning the ensured index names."""

    selected = database if database is not None else get_database()
    ensure_collections(selected)

    names: list[str] = []
    for contract in INDEX_CONTRACTS:
        collection = selected[contract["collection"]]
        if contract["name"] == "created_at_1":
            # Migrate the custom name used by early companion builds. Index
            # names are not part of the data contract, and replacing this one
            # lets MongoDBSaver own the same 24-hour TTL without a startup
            # IndexOptionsConflict.
            for existing_name, existing in collection.index_information().items():
                if (
                    existing_name != contract["name"]
                    and list(existing.get("key", [])) == list(contract["keys"])
                    and existing.get("expireAfterSeconds")
                    == contract["expire_after_seconds"]
                ):
                    collection.drop_index(existing_name)
        options: dict[str, Any] = {
            "name": contract["name"],
            "unique": contract["unique"],
        }
        if contract["expire_after_seconds"] is not None:
            options["expireAfterSeconds"] = contract["expire_after_seconds"]
        collection.create_index(
            list(contract["keys"]),
            **options,
        )
        names.append(contract["name"])

    if include_vector:
        _create_vector_index(selected)
        names.append(VECTOR_INDEX_CONTRACT["name"])
    return tuple(names)
