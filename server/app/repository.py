"""Operation-log storage (docs/05-DATABASE.md).

Nothing in this module understands characters or ordering: an operation is an
opaque JSON object, plus the two fields used for de-duplication.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from .models import Base, Document, Operation, Snapshot


class DocumentNotFoundError(Exception):
    pass


@dataclass(frozen=True)
class StoredOp:
    seq: int
    payload: dict[str, Any]


@dataclass(frozen=True)
class AppendResult:
    """Outcome of storing one batch."""

    new_ops: list[StoredOp]  # ops stored by this call, with their seq (to broadcast)
    max_seq: int  # highest seq among all ops of the batch, new or already stored
    duplicates: int


@dataclass(frozen=True)
class SnapshotRecord:
    up_to_seq: int
    state: dict[str, Any]


def _op_key(op: dict[str, Any]) -> tuple[str, int]:
    return op["op_id"]["r"], int(op["op_id"]["n"])


class OperationLog:
    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine
        self.session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def create_tables(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    # ------------------------------------------------------------- documents

    async def create_document(self, title: str = "Untitled") -> Document:
        async with self.session_factory() as session, session.begin():
            doc = Document(id=uuid.uuid4(), title=title or "Untitled", last_seq=0)
            session.add(doc)
        return doc

    async def get_document(self, doc_id: uuid.UUID) -> Document | None:
        async with self.session_factory() as session:
            return await session.get(Document, doc_id)

    # ------------------------------------------------------------------ write

    async def append_batch(self, doc_id: uuid.UUID, ops: list[dict[str, Any]]) -> AppendResult:
        """Store a batch in ONE transaction (all or nothing).

        1. Reserve a range of seq numbers with a row-locking UPDATE. This
           serialises writers of the same document and leaves other documents
           alone.
        2. Look up which (replica, counter) pairs are already stored.
        3. Insert only the new ones; unused reserved numbers become gaps.
        """
        unique: dict[tuple[str, int], dict[str, Any]] = {}
        for op in ops:
            unique.setdefault(_op_key(op), op)  # duplicates inside the batch
        batch = list(unique.items())
        if not batch:
            return AppendResult(new_ops=[], max_seq=0, duplicates=0)

        async with self.session_factory() as session, session.begin():
            reserved = len(batch)
            result = await session.execute(
                update(Document)
                .where(Document.id == doc_id)
                .values(last_seq=Document.last_seq + reserved, last_activity=func.now())
                .returning(Document.last_seq)
            )
            row = result.first()
            if row is None:
                raise DocumentNotFoundError(str(doc_id))
            top = int(row[0])

            existing_rows = await session.execute(
                select(Operation.op_replica, Operation.op_counter, Operation.seq).where(
                    Operation.doc_id == doc_id,
                    tuple_(Operation.op_replica, Operation.op_counter).in_([k for k, _ in batch]),
                )
            )
            existing = {(r, int(c)): int(s) for r, c, s in existing_rows}

            new_ops: list[StoredOp] = []
            next_seq = top - reserved + 1
            for key, op in batch:
                if key in existing:
                    continue
                session.add(
                    Operation(
                        doc_id=doc_id,
                        seq=next_seq,
                        op_replica=key[0],
                        op_counter=key[1],
                        payload=op,
                    )
                )
                new_ops.append(StoredOp(seq=next_seq, payload=op))
                next_seq += 1

            max_seq = max([s.seq for s in new_ops] + list(existing.values()))
            return AppendResult(
                new_ops=new_ops, max_seq=max_seq, duplicates=len(batch) - len(new_ops)
            )

    # ------------------------------------------------------------------- read

    async def ops_since(self, doc_id: uuid.UUID, seq: int, limit: int) -> list[StoredOp]:
        async with self.session_factory() as session:
            rows = await session.execute(
                select(Operation.seq, Operation.payload)
                .where(Operation.doc_id == doc_id, Operation.seq > seq)
                .order_by(Operation.seq)
                .limit(limit)
            )
            return [StoredOp(seq=int(s), payload=p) for s, p in rows]

    async def oldest_seq(self, doc_id: uuid.UUID) -> int | None:
        async with self.session_factory() as session:
            return await session.scalar(
                select(func.min(Operation.seq)).where(Operation.doc_id == doc_id)
            )

    async def head_seq(self, doc_id: uuid.UUID) -> int:
        async with self.session_factory() as session:
            value = await session.scalar(select(Document.last_seq).where(Document.id == doc_id))
            return int(value or 0)

    # -------------------------------------------------------------- snapshots

    async def latest_snapshot(self, doc_id: uuid.UUID) -> SnapshotRecord | None:
        async with self.session_factory() as session:
            row = (
                await session.execute(
                    select(Snapshot.up_to_seq, Snapshot.state)
                    .where(Snapshot.doc_id == doc_id)
                    .order_by(Snapshot.up_to_seq.desc())
                    .limit(1)
                )
            ).first()
            return SnapshotRecord(up_to_seq=int(row[0]), state=row[1]) if row else None

    async def save_snapshot(self, doc_id: uuid.UUID, up_to_seq: int, state: dict[str, Any]) -> bool:
        """Store a client-uploaded snapshot (05-DATABASE.md section 5).

        Accepted only when `up_to_seq` does not exceed the document's last_seq
        and is newer than the stored snapshot.
        """
        async with self.session_factory() as session, session.begin():
            last_seq = await session.scalar(select(Document.last_seq).where(Document.id == doc_id))
            if last_seq is None or up_to_seq <= 0 or up_to_seq > int(last_seq):
                return False
            newest = await session.scalar(
                select(func.max(Snapshot.up_to_seq)).where(Snapshot.doc_id == doc_id)
            )
            if newest is not None and int(newest) >= up_to_seq:
                return False
            session.add(Snapshot(doc_id=doc_id, up_to_seq=up_to_seq, state=state))
            return True

    async def compact(
        self,
        doc_id: uuid.UUID,
        keep_last_ops: int = 10_000,
        keep_days: float = 7.0,
    ) -> int:
        """Delete operations covered by the newest snapshot (section 5).

        Keeps a safety window: the larger of the last `keep_last_ops`
        operations and the last `keep_days` days. Returns rows deleted.
        """
        snap = await self.latest_snapshot(doc_id)
        if snap is None:
            return 0
        async with self.session_factory() as session, session.begin():
            head = await session.scalar(select(Document.last_seq).where(Document.id == doc_id))
            by_count = int(head or 0) - keep_last_ops
            cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=keep_days)
            newest_old = await session.scalar(
                select(func.max(Operation.seq)).where(
                    Operation.doc_id == doc_id, Operation.created_at < cutoff
                )
            )
            by_age = int(newest_old) if newest_old is not None else 0
            # Never delete past the snapshot, and never inside the safety window.
            limit_seq = min(snap.up_to_seq, by_count, by_age)
            if limit_seq <= 0:
                return 0
            result = await session.execute(
                delete(Operation).where(Operation.doc_id == doc_id, Operation.seq <= limit_seq)
            )
            return int(result.rowcount or 0)
