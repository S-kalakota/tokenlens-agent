"""TokenLens data boundary.

All MongoDB reads and writes must remain under this package.
"""

from db.repo import (
    find_similar,
    load_context,
    log_session,
    log_suggestions,
    match_blocks,
    record_outcome,
)

__all__ = [
    "load_context",
    "match_blocks",
    "log_session",
    "find_similar",
    "log_suggestions",
    "record_outcome",
]
