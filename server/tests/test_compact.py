"""The compaction CLI keeps the safety window and only touches snapshotted documents."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine

from app.compact import compact_all
from app.config import Settings
from app.models import Operation
from app.repository import OperationLog

from .conftest import ins


async def test_compact_all_only_touches_documents_with_a_snapshot(
    settings_factory: Callable[..., Settings], tmp_path: Path
) -> None:
    settings = settings_factory()
    engine = create_async_engine(settings.async_database_url)
    oplog = OperationLog(engine)
    await oplog.create_tables()
    with_snapshot = await oplog.create_document()
    without_snapshot = await oplog.create_document()
    for doc in (with_snapshot, without_snapshot):
        await oplog.append_batch(doc.id, [ins("a", i, i) for i in range(1, 21)])
    await oplog.save_snapshot(with_snapshot.id, 15, {"nodes": []})
    old = dt.datetime.now(dt.UTC) - dt.timedelta(days=30)
    async with oplog.session_factory() as session, session.begin():
        await session.execute(update(Operation).values(created_at=old))
    await engine.dispose()

    deleted = await compact_all(settings, keep_ops=5, keep_days=7)

    assert deleted == {str(with_snapshot.id): 15}  # up to the snapshot (15), 20-5 = 15
    engine = create_async_engine(settings.async_database_url)
    oplog = OperationLog(engine)
    assert await oplog.oldest_seq(with_snapshot.id) == 16
    assert await oplog.oldest_seq(without_snapshot.id) == 1
    await engine.dispose()
