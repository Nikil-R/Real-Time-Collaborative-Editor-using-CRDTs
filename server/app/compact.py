"""Compaction job (docs/05-DATABASE.md section 5).

Deletes operations that are covered by a stored snapshot AND outside the safety
window (the larger of the last N operations and the last D days).

    uv run python -m app.compact --keep-ops 10000 --keep-days 7
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from .config import Settings
from .models import Snapshot
from .repository import OperationLog


async def compact_all(settings: Settings, keep_ops: int, keep_days: float) -> dict[str, int]:
    """Compact every document that has a snapshot. Returns rows deleted per document id."""
    engine = create_async_engine(settings.async_database_url)
    try:
        oplog = OperationLog(engine)
        async with oplog.session_factory() as session:
            doc_ids = (await session.scalars(select(Snapshot.doc_id).distinct())).all()
        deleted: dict[str, int] = {}
        for doc_id in doc_ids:
            count = await oplog.compact(doc_id, keep_last_ops=keep_ops, keep_days=keep_days)
            if count:
                deleted[str(doc_id)] = count
        return deleted
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Delete operations covered by snapshots.")
    parser.add_argument("--keep-ops", type=int, default=10_000)
    parser.add_argument("--keep-days", type=float, default=7.0)
    args = parser.parse_args()
    deleted = asyncio.run(compact_all(Settings(), args.keep_ops, args.keep_days))
    total = sum(deleted.values())
    print(f"compacted {len(deleted)} document(s), deleted {total} operation(s)")


if __name__ == "__main__":
    main()
