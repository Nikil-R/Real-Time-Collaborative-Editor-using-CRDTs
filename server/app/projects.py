"""Workspace REST API and the project's realtime channel.

REST creates, renames and deletes files. Every change is pushed to everybody
in the project over `/ws/projects/{id}` (file list, who is looking at which
file, and the activity feed). Editing itself still happens over the normal
per-file document channel; the project channel never carries operations.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from typing import Any

import structlog
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from . import protocol as proto
from .activity import project_room
from .config import Settings
from .hub import Client, Hub
from .projects_store import (
    InvalidNameError,
    NameTakenError,
    ProjectFileNotFoundError,
    ProjectStore,
    TooManyFilesError,
    file_dict,
)
from .templates import STARTER_FILES
from .wsutil import SocketAdapter, origin_allowed, send_error

log = structlog.get_logger()


class CreateProject(BaseModel):
    name: str = Field(default="Untitled project", max_length=120)


class FileName(BaseModel):
    name: str = Field(max_length=200)


async def push(state: dict[str, Any], project_id: uuid.UUID, message: dict[str, Any]) -> None:
    """Send a message to everyone in a project, on this process and on others (Redis)."""
    room = project_room(project_id)
    state["hub"].broadcast(room, message)
    await state["fanout"].publish(room, message)


async def files_changed(state: dict[str, Any], project_id: uuid.UUID) -> None:
    files = await state["projects"].list_files(project_id)
    await push(state, project_id, {"type": "files_changed", "files": [file_dict(f) for f in files]})


async def log_event(
    state: dict[str, Any],
    project_id: uuid.UUID,
    actor: str,
    kind: str,
    file_id: uuid.UUID | None,
    file_name: str | None,
) -> None:
    event = await state["projects"].add_activity(
        project_id, actor or "Someone", kind, file_id, file_name
    )
    await push(state, project_id, {"type": "activity", "event": event})


def register_project_routes(app: FastAPI, state: dict[str, Any], settings: Settings) -> None:
    def store() -> ProjectStore:
        return state["projects"]  # type: ignore[no-any-return]

    async def project_or_404(project_id: uuid.UUID) -> Any:
        project = await store().get_project(project_id)
        if project is None:
            raise HTTPException(404, "project not found")
        return project

    def actor_from(header: str | None) -> str:
        return (header or "Someone").strip()[:64] or "Someone"

    @app.post("/api/projects", status_code=201)
    async def create_project(body: CreateProject | None = None) -> dict[str, Any]:
        name = (body or CreateProject()).name
        project, files = await store().create_project(name, STARTER_FILES)
        return {
            "id": str(project.id),
            "name": project.name,
            "files": [file_dict(f) for f in sorted(files, key=lambda f: (f.name or "").lower())],
        }

    @app.get("/api/projects/{project_id}")
    async def get_project(project_id: uuid.UUID) -> dict[str, Any]:
        project = await project_or_404(project_id)
        files = await store().list_files(project_id)
        return {"id": str(project.id), "name": project.name, "files": [file_dict(f) for f in files]}

    @app.post("/api/projects/{project_id}/files", status_code=201)
    async def create_file(
        project_id: uuid.UUID, body: FileName, x_actor: str | None = Header(default=None)
    ) -> dict[str, Any]:
        await project_or_404(project_id)
        try:
            doc = await store().create_file(project_id, body.name)
        except InvalidNameError as exc:
            raise HTTPException(422, str(exc)) from exc
        except NameTakenError as exc:
            raise HTTPException(409, "a file with that name already exists") from exc
        except TooManyFilesError as exc:
            raise HTTPException(409, "too many files in this project") from exc
        await files_changed(state, project_id)
        await log_event(state, project_id, actor_from(x_actor), "file_created", doc.id, doc.name)
        return file_dict(doc)

    @app.patch("/api/projects/{project_id}/files/{file_id}")
    async def rename_file(
        project_id: uuid.UUID,
        file_id: uuid.UUID,
        body: FileName,
        x_actor: str | None = Header(default=None),
    ) -> dict[str, Any]:
        try:
            doc, old = await store().rename_file(project_id, file_id, body.name)
        except InvalidNameError as exc:
            raise HTTPException(422, str(exc)) from exc
        except NameTakenError as exc:
            raise HTTPException(409, "a file with that name already exists") from exc
        except ProjectFileNotFoundError as exc:
            raise HTTPException(404, "file not found") from exc
        await files_changed(state, project_id)
        await log_event(
            state, project_id, actor_from(x_actor), "file_renamed", doc.id, f"{old} → {doc.name}"
        )
        return file_dict(doc)

    @app.delete("/api/projects/{project_id}/files/{file_id}", status_code=204)
    async def delete_file(
        project_id: uuid.UUID, file_id: uuid.UUID, x_actor: str | None = Header(default=None)
    ) -> None:
        try:
            name = await store().delete_file(project_id, file_id)
        except ProjectFileNotFoundError as exc:
            raise HTTPException(404, "file not found") from exc
        await files_changed(state, project_id)
        await log_event(state, project_id, actor_from(x_actor), "file_deleted", file_id, name)

    @app.get("/api/projects/{project_id}/activity")
    async def list_activity(project_id: uuid.UUID, limit: int = 50) -> dict[str, Any]:
        await project_or_404(project_id)
        return {"events": await store().list_activity(project_id, limit)}

    @app.post("/api/files/{file_id}/claim-seed")
    async def claim_seed(file_id: uuid.UUID) -> dict[str, Any]:
        """Hand the starter text of a new file to exactly one client (it types it in)."""
        return {"text": await store().claim_seed(file_id)}

    @app.websocket("/ws/projects/{project_id}")
    async def project_socket(ws: WebSocket, project_id: str) -> None:
        await serve_project_socket(ws, project_id, settings, state)


async def serve_project_socket(
    ws: WebSocket, project_id_raw: str, settings: Settings, state: dict[str, Any]
) -> None:
    hub: Hub = state["hub"]
    fanout = state["fanout"]
    metrics = state["metrics"]
    store: ProjectStore = state["projects"]

    if not origin_allowed(ws, settings):
        await ws.close(1008)
        return
    await ws.accept()
    try:
        project_id = uuid.UUID(project_id_raw)
    except ValueError:
        await send_error(ws, metrics, proto.DOC_NOT_FOUND, "invalid project id")
        await ws.close(4404)
        return
    project = await store.get_project(project_id)
    if project is None:
        await send_error(ws, metrics, proto.DOC_NOT_FOUND, "project not found")
        await ws.close(4404)
        return
    room = project_room(project_id)

    try:
        raw = await asyncio.wait_for(ws.receive_text(), settings.hello_timeout_sec)
        if len(raw.encode()) > settings.max_message_bytes:
            raise proto.ProtocolError(proto.TOO_LARGE, "message too large")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise proto.ProtocolError(proto.BAD_MESSAGE, "invalid JSON") from exc
        hello = proto.parse_client_message(data, settings.max_ops_per_batch)
        if not isinstance(hello, proto.Hello):
            raise proto.ProtocolError(proto.BAD_MESSAGE, "first message must be hello")
    except proto.ProtocolError as err:
        await send_error(ws, metrics, err.code, err.message)
        await ws.close(1002)
        return
    except (TimeoutError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await ws.close(1002)
        return

    if hub.replica_in_use(room, hello.replica):
        await send_error(ws, metrics, proto.REPLICA_IN_USE, "replica id already connected")
        await ws.close(4409)
        return

    client = Client(
        client_id=uuid.uuid4().hex,
        doc_id=room,
        replica=hello.replica,
        name=hello.name,
        color=hello.color,
        socket=SocketAdapter(ws),
        queue=asyncio.Queue(maxsize=settings.send_queue_size),
    )
    client.meta["file_id"] = None
    hub.add(client)
    try:
        files = await store.list_files(project_id)
        activity = await store.list_activity(project_id, 50)
        welcome = {
            "type": "welcome",
            "project": {"id": str(project.id), "name": project.name},
            "files": [file_dict(f) for f in files],
            "peers": hub.peers(room, exclude_replica=client.replica),
            "activity": activity,
        }
        await ws.send_text(json.dumps(welcome, separators=(",", ":")))
        hub.start_writer(client)
        joined = {"type": "peer_joined", **client.peer_info()}
        hub.broadcast(room, joined, exclude_replica=client.replica)
        await fanout.publish(room, {**joined, "announce": True}, exclude_replica=client.replica)

        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), settings.idle_timeout_sec)
            except TimeoutError:
                await ws.close(1001)
                return
            if client.closed:
                return
            if len(raw.encode()) > settings.max_message_bytes:
                hub.enqueue(client, proto.error_message(proto.TOO_LARGE, "message too large"))
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                hub.enqueue(client, proto.error_message(proto.BAD_MESSAGE, "invalid JSON"))
                continue
            kind = msg.get("type") if isinstance(msg, dict) else None
            if kind == "ping":
                hub.enqueue(client, {"type": "pong", "t": msg.get("t", 0)})
            elif kind == "focus":
                file_id = msg.get("file_id")
                if file_id is not None:
                    try:
                        file_id = str(uuid.UUID(str(file_id)))
                    except ValueError:
                        hub.enqueue(
                            client, proto.error_message(proto.BAD_MESSAGE, "invalid file_id")
                        )
                        continue
                client.meta["file_id"] = file_id
                focus = {"type": "focus", **client.peer_info()}
                hub.broadcast(room, focus, exclude_replica=client.replica)
                await fanout.publish(room, focus, exclude_replica=client.replica)
            else:
                hub.enqueue(client, proto.error_message(proto.BAD_MESSAGE, "unknown message type"))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.error("project_session_error", error=repr(exc))
        await send_error(ws, metrics, proto.INTERNAL, "internal error")
    finally:
        hub.remove(client)
        await hub.stop_writer(client)
        left = {"type": "peer_left", "replica": client.replica}
        hub.broadcast(room, left, exclude_replica=client.replica)
        await fanout.publish(room, left, exclude_replica=client.replica)
        with contextlib.suppress(Exception):
            await ws.close()
