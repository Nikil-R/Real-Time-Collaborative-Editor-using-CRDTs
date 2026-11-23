"""Workspaces: projects, their files and the activity history.

A project is a set of files; every file is one collaborative document (its
operations live in the normal operation log). Nothing here understands CRDT
operations: the server only manages names, ordering of the file list and history.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select, update

from .models import Activity, Document, Project
from .repository import OperationLog

MAX_NAME_LENGTH = 120
MAX_FILES_PER_PROJECT = 200
EDIT_MERGE_WINDOW_SECONDS = 60


class ProjectNotFoundError(Exception):
    pass


class ProjectFileNotFoundError(Exception):
    pass


class InvalidNameError(ValueError):
    pass


class NameTakenError(Exception):
    pass


class TooManyFilesError(Exception):
    pass


def validate_file_name(raw: str) -> str:
    """A path such as `src/app.ts`: no empty segments, no `..`, no control characters."""
    name = raw.strip()
    if not name or len(name) > MAX_NAME_LENGTH:
        raise InvalidNameError(f"name must be 1 to {MAX_NAME_LENGTH} characters")
    if "\\" in name or any(ord(c) < 32 for c in name):
        raise InvalidNameError("name contains forbidden characters")
    parts = name.split("/")
    if any(p.strip() == "" or p in (".", "..") for p in parts):
        raise InvalidNameError("name must be a path without empty or '..' segments")
    return name


def file_dict(doc: Document) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "name": doc.name or "untitled",
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
    }


def activity_dict(row: Activity) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "ts": _aware(row.ts).isoformat(),
        "actor": row.actor,
        "kind": row.kind,
        "file_id": str(row.file_id) if row.file_id else None,
        "file_name": row.file_name,
        "count": int(row.count),
    }


def _aware(ts: dt.datetime) -> dt.datetime:
    """SQLite returns naive datetimes; they are stored as UTC."""
    return ts if ts.tzinfo else ts.replace(tzinfo=dt.UTC)


@dataclass(frozen=True)
class FileRef:
    project_id: uuid.UUID
    name: str


class ProjectStore:
    def __init__(self, oplog: OperationLog) -> None:
        self.oplog = oplog
        self._session = oplog.session_factory
        # doc id -> (project id, file name); avoids a query for every stored batch.
        self._file_cache: dict[uuid.UUID, FileRef | None] = {}

    # ---------------------------------------------------------------- projects

    async def create_project(
        self, name: str, starter_files: list[tuple[str, str]]
    ) -> tuple[Project, list[Document]]:
        async with self._session() as session, session.begin():
            project = Project(id=uuid.uuid4(), name=(name.strip() or "Untitled project")[:120])
            session.add(project)
            await session.flush()  # the project row must exist before its files
            files = []
            for file_name, seed in starter_files:
                doc = Document(
                    id=uuid.uuid4(),
                    title=file_name,
                    project_id=project.id,
                    name=validate_file_name(file_name),
                    seed_text=seed or None,
                )
                session.add(doc)
                files.append(doc)
        return project, files

    async def get_project(self, project_id: uuid.UUID) -> Project | None:
        async with self._session() as session:
            return await session.get(Project, project_id)

    async def list_files(self, project_id: uuid.UUID) -> list[Document]:
        async with self._session() as session:
            rows = await session.scalars(
                select(Document)
                .where(Document.project_id == project_id, Document.deleted_at.is_(None))
                .order_by(func.lower(Document.name))
            )
            return list(rows)

    # ------------------------------------------------------------------- files

    async def create_file(
        self, project_id: uuid.UUID, raw_name: str, seed_text: str | None = None
    ) -> Document:
        name = validate_file_name(raw_name)
        async with self._session() as session, session.begin():
            if await session.get(Project, project_id) is None:
                raise ProjectNotFoundError(str(project_id))
            existing = (
                await session.scalars(
                    select(Document.name).where(
                        Document.project_id == project_id, Document.deleted_at.is_(None)
                    )
                )
            ).all()
            if len(existing) >= MAX_FILES_PER_PROJECT:
                raise TooManyFilesError(str(MAX_FILES_PER_PROJECT))
            if name.lower() in {(n or "").lower() for n in existing}:
                raise NameTakenError(name)
            doc = Document(
                id=uuid.uuid4(),
                title=name,
                project_id=project_id,
                name=name,
                seed_text=seed_text or None,
            )
            session.add(doc)
        return doc

    async def rename_file(
        self, project_id: uuid.UUID, file_id: uuid.UUID, raw_name: str
    ) -> tuple[Document, str]:
        """Returns the updated file and its previous name."""
        name = validate_file_name(raw_name)
        async with self._session() as session, session.begin():
            doc = await session.get(Document, file_id)
            if doc is None or doc.project_id != project_id or doc.deleted_at is not None:
                raise ProjectFileNotFoundError(str(file_id))
            others = (
                await session.scalars(
                    select(Document.name).where(
                        Document.project_id == project_id,
                        Document.deleted_at.is_(None),
                        Document.id != file_id,
                    )
                )
            ).all()
            if name.lower() in {(n or "").lower() for n in others}:
                raise NameTakenError(name)
            old = doc.name or "untitled"
            doc.name = name
            doc.title = name
        self._file_cache.pop(file_id, None)
        return doc, old

    async def delete_file(self, project_id: uuid.UUID, file_id: uuid.UUID) -> str:
        """Soft delete (the operation log is kept). Returns the file's name."""
        async with self._session() as session, session.begin():
            doc = await session.get(Document, file_id)
            if doc is None or doc.project_id != project_id or doc.deleted_at is not None:
                raise ProjectFileNotFoundError(str(file_id))
            doc.deleted_at = dt.datetime.now(dt.UTC)
            name = doc.name or "untitled"
        self._file_cache[file_id] = None
        return name

    async def claim_seed(self, file_id: uuid.UUID) -> str | None:
        """Atomically take the starter text of a file: exactly one caller ever gets it."""
        async with self._session() as session, session.begin():
            result = await session.execute(
                update(Document)
                .where(
                    Document.id == file_id,
                    Document.seed_claimed.is_(False),
                    Document.seed_text.is_not(None),
                    Document.deleted_at.is_(None),
                )
                .values(seed_claimed=True)
                .returning(Document.seed_text)
            )
            row = result.first()
            return str(row[0]) if row else None

    async def file_ref(self, doc_id: uuid.UUID) -> FileRef | None:
        """Project and name of a document, or None for a standalone one (cached)."""
        if doc_id in self._file_cache:
            return self._file_cache[doc_id]
        async with self._session() as session:
            row = (
                await session.execute(
                    select(Document.project_id, Document.name).where(
                        Document.id == doc_id, Document.deleted_at.is_(None)
                    )
                )
            ).first()
        ref = FileRef(row[0], row[1] or "untitled") if row and row[0] else None
        self._file_cache[doc_id] = ref
        return ref

    # ---------------------------------------------------------------- activity

    async def add_activity(
        self,
        project_id: uuid.UUID,
        actor: str,
        kind: str,
        file_id: uuid.UUID | None = None,
        file_name: str | None = None,
        count: int = 0,
    ) -> dict[str, Any]:
        async with self._session() as session, session.begin():
            row = Activity(
                project_id=project_id,
                actor=actor[:64],
                kind=kind,
                file_id=file_id,
                file_name=file_name,
                count=count,
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            return activity_dict(row)

    async def add_edit_activity(
        self,
        project_id: uuid.UUID,
        actor: str,
        file_id: uuid.UUID,
        file_name: str,
        count: int,
    ) -> dict[str, Any]:
        """Record edits, merging into the newest row when it is the same person and file."""
        now = dt.datetime.now(dt.UTC)
        async with self._session() as session, session.begin():
            last = (
                await session.scalars(
                    select(Activity)
                    .where(Activity.project_id == project_id)
                    .order_by(Activity.id.desc())
                    .limit(1)
                )
            ).first()
            if (
                last is not None
                and last.kind == "edit"
                and last.actor == actor[:64]
                and last.file_id == file_id
                and (now - _aware(last.ts)).total_seconds() <= EDIT_MERGE_WINDOW_SECONDS
            ):
                last.count += count
                last.ts = now
                last.file_name = file_name
                await session.flush()
                return activity_dict(last)
            row = Activity(
                project_id=project_id,
                actor=actor[:64],
                kind="edit",
                file_id=file_id,
                file_name=file_name,
                count=count,
                ts=now,
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            return activity_dict(row)

    async def list_activity(self, project_id: uuid.UUID, limit: int = 50) -> list[dict[str, Any]]:
        async with self._session() as session:
            rows = await session.scalars(
                select(Activity)
                .where(Activity.project_id == project_id)
                .order_by(Activity.id.desc())
                .limit(max(1, min(limit, 200)))
            )
            return [activity_dict(r) for r in rows]
