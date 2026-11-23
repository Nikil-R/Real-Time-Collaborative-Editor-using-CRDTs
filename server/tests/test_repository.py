"""Database layer tests (docs/05-DATABASE.md section 9)."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import create_async_engine

from app.models import Operation
from app.repository import DocumentNotFoundError, OperationLog

from .conftest import dele, ins


@pytest.fixture
async def oplog(tmp_path: Path) -> AsyncIterator[OperationLog]:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{(tmp_path / 'repo.db').as_posix()}", connect_args={"timeout": 30}
    )
    log = OperationLog(engine)
    await log.create_tables()
    yield log
    await engine.dispose()


async def test_append_assigns_increasing_seq(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    r1 = await oplog.append_batch(doc.id, [ins("a", 1, 1), ins("a", 2, 2)])
    r2 = await oplog.append_batch(doc.id, [ins("a", 3, 3)])
    assert [o.seq for o in r1.new_ops] == [1, 2]
    assert [o.seq for o in r2.new_ops] == [3]
    assert r2.max_seq == 3
    assert await oplog.head_seq(doc.id) == 3


async def test_same_batch_twice_stores_nothing_new_but_reports_max_seq(
    oplog: OperationLog,
) -> None:
    doc = await oplog.create_document()
    batch = [ins("a", 1, 1), dele("a", 2, 1, "a")]
    first = await oplog.append_batch(doc.id, batch)
    again = await oplog.append_batch(doc.id, batch)
    assert len(first.new_ops) == 2
    assert again.new_ops == []
    assert again.duplicates == 2
    assert again.max_seq == first.max_seq
    assert len(await oplog.ops_since(doc.id, 0, 100)) == 2


async def test_duplicates_inside_one_batch_are_stored_once(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    result = await oplog.append_batch(doc.id, [ins("a", 1, 1), ins("a", 1, 1)])
    assert len(result.new_ops) == 1


async def test_mixed_batch_stores_only_new_ops(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    await oplog.append_batch(doc.id, [ins("a", 1, 1)])
    result = await oplog.append_batch(doc.id, [ins("a", 1, 1), ins("a", 2, 2)])
    assert [o.payload["op_id"]["n"] for o in result.new_ops] == [2]
    assert result.duplicates == 1
    # seq stays strictly increasing even though a number may be skipped
    seqs = [o.seq for o in await oplog.ops_since(doc.id, 0, 10)]
    assert seqs == sorted(set(seqs))


async def test_missing_document_raises(oplog: OperationLog) -> None:
    with pytest.raises(DocumentNotFoundError):
        await oplog.append_batch(uuid.uuid4(), [ins("a", 1, 1)])


async def test_concurrent_writers_get_unique_increasing_seq(oplog: OperationLog) -> None:
    doc = await oplog.create_document()

    async def writer(name: str) -> list[int]:
        seqs: list[int] = []
        for i in range(1, 21):
            res = await oplog.append_batch(doc.id, [ins(name, i, i)])
            seqs.extend(o.seq for o in res.new_ops)
        return seqs

    results = await asyncio.gather(*(writer(f"w{i}") for i in range(6)))
    all_seqs = [s for r in results for s in r]
    assert len(all_seqs) == 120
    assert len(set(all_seqs)) == 120  # no duplicate seq
    stored = [o.seq for o in await oplog.ops_since(doc.id, 0, 1000)]
    assert stored == sorted(stored)
    assert len(stored) == 120


async def test_concurrent_identical_batches_store_each_op_once(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    batch = [ins("a", i, i) for i in range(1, 11)]
    await asyncio.gather(*(oplog.append_batch(doc.id, batch) for _ in range(5)))
    assert len(await oplog.ops_since(doc.id, 0, 100)) == 10


async def test_catch_up_pages_return_everything_in_order(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    for start in range(0, 25, 5):
        await oplog.append_batch(doc.id, [ins("a", i + 1, i + 1) for i in range(start, start + 5)])
    seen: list[int] = []
    cursor = 0
    while True:
        page = await oplog.ops_since(doc.id, cursor, 7)
        if not page:
            break
        seen.extend(o.seq for o in page)
        cursor = page[-1].seq
    assert seen == list(range(1, 26))


async def test_failed_batch_is_rolled_back_completely(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    await oplog.append_batch(doc.id, [ins("a", 1, 1)])
    bad = ins("a", 3, 3)
    bad["unserialisable"] = {1, 2, 3}  # a set cannot be stored as JSON
    with pytest.raises(Exception):  # noqa: B017 - any serialisation error is fine here
        await oplog.append_batch(doc.id, [ins("a", 2, 2), bad])
    assert await oplog.head_seq(doc.id) == 1  # the seq reservation rolled back too
    assert [o.seq for o in await oplog.ops_since(doc.id, 0, 10)] == [1]


async def test_snapshot_rules(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    await oplog.append_batch(doc.id, [ins("a", i, i) for i in range(1, 6)])
    assert await oplog.save_snapshot(doc.id, 3, {"nodes": [1]}) is True
    assert await oplog.save_snapshot(doc.id, 3, {"nodes": [2]}) is False  # not newer
    assert await oplog.save_snapshot(doc.id, 2, {"nodes": [2]}) is False  # older
    assert await oplog.save_snapshot(doc.id, 99, {"nodes": [2]}) is False  # beyond last_seq
    assert await oplog.save_snapshot(doc.id, 5, {"nodes": [3]}) is True
    snap = await oplog.latest_snapshot(doc.id)
    assert snap is not None
    assert snap.up_to_seq == 5
    assert snap.state == {"nodes": [3]}


async def test_compaction_keeps_the_safety_window(oplog: OperationLog) -> None:
    doc = await oplog.create_document()
    await oplog.append_batch(doc.id, [ins("a", i, i) for i in range(1, 21)])
    assert await oplog.compact(doc.id) == 0  # no snapshot yet
    await oplog.save_snapshot(doc.id, 15, {"nodes": []})
    # Everything is brand new, so the 7-day window protects all of it.
    assert await oplog.compact(doc.id, keep_last_ops=0, keep_days=7) == 0
    # Age the first 10 operations by 30 days.
    async with oplog.session_factory() as session, session.begin():
        await session.execute(
            update(Operation)
            .where(Operation.doc_id == doc.id, Operation.seq <= 10)
            .values(created_at=dt.datetime.now(dt.UTC) - dt.timedelta(days=30))
        )
    deleted = await oplog.compact(doc.id, keep_last_ops=5, keep_days=7)
    assert deleted == 10  # old enough, below the snapshot (15) and outside the last 5
    assert await oplog.oldest_seq(doc.id) == 11
    async with oplog.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(Operation))
        assert count == 10
