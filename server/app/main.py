"""FastAPI application: REST for documents, WebSocket relay for operations.

Principle (docs/02-ARCHITECTURE.md): clients own the merge logic, the server
owns delivery and storage. Nothing here interprets an operation.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from . import protocol as proto
from .config import Settings
from .fanout import Fanout, RedisFanout
from .hub import Client, Hub
from .logging_setup import configure_logging
from .metrics import Metrics
from .repository import DocumentNotFoundError, OperationLog, StoredOp

log = structlog.get_logger()


class CreateDocument(BaseModel):
    title: str = Field(default="Untitled", max_length=200)


def _ops_payload(stored: list[StoredOp]) -> list[dict[str, Any]]:
    return [{**s.payload, "seq": s.seq} for s in stored]


def create_app(settings: Settings | None = None, redis_client: Any | None = None) -> FastAPI:
    """Build an app. `redis_client` lets tests inject fakeredis."""
    settings = settings or Settings()
    configure_logging(settings.log_level)

    state: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        connect_args: dict[str, Any] = {}
        if settings.async_database_url.startswith("sqlite"):
            connect_args["timeout"] = 30  # wait for the file lock instead of failing
        engine: AsyncEngine = create_async_engine(
            settings.async_database_url, connect_args=connect_args, pool_pre_ping=True
        )
        oplog = OperationLog(engine)
        if settings.auto_create_tables:
            await oplog.create_tables()

        fanout: Fanout
        if redis_client is not None:
            fanout = RedisFanout(redis_client, settings.server_id)
        elif settings.redis_url:
            from redis import asyncio as aioredis

            fanout = RedisFanout(aioredis.from_url(settings.redis_url), settings.server_id)
        else:
            fanout = Fanout()

        hub = Hub()
        metrics = Metrics()
        state.update(engine=engine, oplog=oplog, fanout=fanout, hub=hub, metrics=metrics)
        app.state.hub = hub
        app.state.oplog = oplog
        app.state.metrics = metrics
        app.state.fanout = fanout
        app.state.settings = settings

        async def on_remote(
            doc_id: str, message: dict[str, Any], exclude: str | None, origin: str
        ) -> None:
            await _handle_remote(hub, fanout, settings, doc_id, message, exclude, origin)

        await fanout.start(on_remote)
        log.info("server_started", server_id=settings.server_id, redis=fanout.enabled)
        try:
            yield
        finally:
            await fanout.stop()
            await engine.dispose()
            log.info("server_stopped", server_id=settings.server_id)

    app = FastAPI(title="Collaborative editor relay", version="0.1.0", lifespan=lifespan)
    if settings.origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.origins,
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )

    # ------------------------------------------------------------------ REST

    @app.get("/health")
    async def health() -> dict[str, Any]:
        db_ok = True
        try:
            async with state["engine"].connect() as conn:
                await conn.execute(text("SELECT 1"))
        except Exception:
            db_ok = False
        redis_state: str | bool = "disabled"
        if state["fanout"].enabled:
            redis_state = await state["fanout"].ping()
        ok = db_ok and redis_state in (True, "disabled")
        return {
            "status": "ok" if ok else "degraded",
            "database": db_ok,
            "redis": redis_state,
            "clients": state["hub"].client_count,
            "server_id": settings.server_id,
        }

    @app.get("/metrics")
    async def metrics_endpoint() -> Response:
        m: Metrics = state["metrics"]
        m.connected_clients.set(state["hub"].client_count)
        return Response(m.render(), media_type="text/plain; version=0.0.4")

    @app.post("/api/documents", status_code=201)
    async def create_document(body: CreateDocument | None = None) -> dict[str, Any]:
        doc = await state["oplog"].create_document((body or CreateDocument()).title)
        return {"id": str(doc.id), "title": doc.title, "last_seq": 0}

    @app.get("/api/documents/{doc_id}")
    async def get_document(doc_id: uuid.UUID) -> dict[str, Any]:
        doc = await state["oplog"].get_document(doc_id)
        if doc is None:
            raise HTTPException(404, "document not found")
        return {"id": str(doc.id), "title": doc.title, "last_seq": int(doc.last_seq)}

    @app.get("/api/documents/{doc_id}/snapshot")
    async def get_snapshot(doc_id: uuid.UUID) -> dict[str, Any]:
        snap = await state["oplog"].latest_snapshot(doc_id)
        if snap is None:
            raise HTTPException(404, "no snapshot")
        return {"up_to_seq": snap.up_to_seq, "state": snap.state}

    # ------------------------------------------------------------- WebSocket

    @app.websocket("/ws/{doc_id}")
    async def ws_endpoint(ws: WebSocket, doc_id: str) -> None:
        await _serve_socket(ws, doc_id, settings, state)

    return app


# --------------------------------------------------------------------------
# WebSocket session
# --------------------------------------------------------------------------


class _SocketAdapter:
    """Adapts a Starlette WebSocket to the Hub's small Sender protocol."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws

    async def send_text(self, data: str) -> None:
        await self.ws.send_text(data)

    async def close(self, code: int = 1000) -> None:
        await self.ws.close(code)


def _origin_allowed(ws: WebSocket, settings: Settings) -> bool:
    origin = ws.headers.get("origin")
    if origin is None or "*" in settings.origins:
        return True  # non-browser clients (load test, scripts) send no Origin
    return origin in settings.origins


async def _send_error(ws: WebSocket, metrics: Metrics, code: str, message: str) -> None:
    metrics.errors_total.labels(code=code).inc()
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(proto.error_message(code, message)))


async def _serve_socket(
    ws: WebSocket, doc_id_raw: str, settings: Settings, state: dict[str, Any]
) -> None:
    hub: Hub = state["hub"]
    oplog: OperationLog = state["oplog"]
    fanout: Fanout = state["fanout"]
    metrics: Metrics = state["metrics"]

    if not _origin_allowed(ws, settings):
        await ws.close(1008)
        return
    await ws.accept()

    try:
        doc_uuid = uuid.UUID(doc_id_raw)
    except ValueError:
        await _send_error(ws, metrics, proto.DOC_NOT_FOUND, "invalid document id")
        await ws.close(4404)
        return
    doc_id = str(doc_uuid)
    if await oplog.get_document(doc_uuid) is None:
        await _send_error(ws, metrics, proto.DOC_NOT_FOUND, "document not found")
        await ws.close(4404)
        return

    # ---- hello -----------------------------------------------------------
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
        await _send_error(ws, metrics, err.code, err.message)
        await ws.close(1002)
        return
    except (TimeoutError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await ws.close(1002)
        return

    if hub.replica_in_use(doc_id, hello.replica):
        await _send_error(ws, metrics, proto.REPLICA_IN_USE, "replica id already connected")
        await ws.close(4409)
        return
    if len(hub.room(doc_id)) >= settings.max_clients_per_document:
        await _send_error(ws, metrics, proto.RATE_LIMITED, "document is full")
        await ws.close(1013)
        return

    client = Client(
        client_id=uuid.uuid4().hex,
        doc_id=doc_id,
        replica=hello.replica,
        name=hello.name,
        color=hello.color,
        socket=_SocketAdapter(ws),
        queue=asyncio.Queue(maxsize=settings.send_queue_size),
        tokens=float(settings.rate_limit_ops_per_sec),
        last_refill=time.monotonic(),
    )
    hub.add(client)
    bound = log.bind(doc_id=doc_id, replica=client.replica)
    try:
        # Registered before the catch-up query, so nothing broadcast in
        # between is missed; the client applies operations idempotently.
        welcome = await _build_welcome(oplog, settings, doc_uuid, doc_id, hello, hub, client)
        await ws.send_text(json.dumps(welcome, separators=(",", ":")))
        hub.start_writer(client)
        joined = {"type": "peer_joined", **client.peer_info()}
        hub.broadcast(doc_id, joined, exclude_replica=client.replica)
        await fanout.publish(doc_id, {**joined, "announce": True}, exclude_replica=client.replica)
        bound.info("client_connected", last_seq=hello.last_seq, head_seq=welcome["head_seq"])
        await _receive_loop(ws, client, settings, state, doc_uuid, bound)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        bound.error("session_error", error=repr(exc))
        await _send_error(ws, metrics, proto.INTERNAL, "internal error")
    finally:
        hub.remove(client)
        await hub.stop_writer(client)
        left = {"type": "peer_left", "replica": client.replica}
        hub.broadcast(doc_id, left, exclude_replica=client.replica)
        await fanout.publish(doc_id, left, exclude_replica=client.replica)
        if client.dropped:
            metrics.dropped_clients_total.inc()
        bound.info("client_disconnected")
        with contextlib.suppress(Exception):
            await ws.close()


async def _build_welcome(
    oplog: OperationLog,
    settings: Settings,
    doc_uuid: uuid.UUID,
    doc_id: str,
    hello: proto.Hello,
    hub: Hub,
    client: Client,
) -> dict[str, Any]:
    """Snapshot (if useful) plus the first page of operations after it."""
    snapshot_payload: dict[str, Any] | None = None
    since = hello.last_seq
    snap = await oplog.latest_snapshot(doc_uuid)
    if snap is not None and snap.up_to_seq > hello.last_seq:
        oldest = await oplog.oldest_seq(doc_uuid)
        # New clients start from the snapshot (faster than replaying the log).
        # Returning clients need it only if the operations they missed were
        # compacted away.
        needs_snapshot = hello.last_seq == 0 or oldest is None or hello.last_seq < oldest - 1
        if needs_snapshot:
            snapshot_payload = {"up_to_seq": snap.up_to_seq, "state": snap.state}
            since = snap.up_to_seq
    page = await oplog.ops_since(doc_uuid, since, settings.catchup_page_size)
    head = await oplog.head_seq(doc_uuid)
    more = len(page) == settings.catchup_page_size and page[-1].seq < head
    return {
        "type": "welcome",
        "doc_id": doc_id,
        "snapshot": snapshot_payload,
        "ops_since": _ops_payload(page),
        "more": more,
        "head_seq": head,
        "peers": hub.peers(doc_id, exclude_replica=client.replica),
    }


async def _receive_loop(
    ws: WebSocket,
    client: Client,
    settings: Settings,
    state: dict[str, Any],
    doc_uuid: uuid.UUID,
    bound: Any,
) -> None:
    hub: Hub = state["hub"]
    oplog: OperationLog = state["oplog"]
    fanout: Fanout = state["fanout"]
    metrics: Metrics = state["metrics"]
    doc_id = client.doc_id

    def reply(message: dict[str, Any]) -> None:
        hub.enqueue(client, message)

    def refuse(code: str, message: str) -> None:
        metrics.errors_total.labels(code=code).inc()
        reply(proto.error_message(code, message))

    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), settings.idle_timeout_sec)
        except TimeoutError:
            bound.info("idle_timeout")
            await ws.close(1001)
            return
        if client.closed:
            return
        if len(raw.encode()) > settings.max_message_bytes:
            refuse(proto.TOO_LARGE, "message too large")
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            refuse(proto.BAD_MESSAGE, "invalid JSON")
            continue
        try:
            msg = proto.parse_client_message(data, settings.max_ops_per_batch)
        except proto.ProtocolError as err:
            refuse(err.code, err.message)
            continue

        if isinstance(msg, proto.PingMsg):
            reply({"type": "pong", "t": msg.t})

        elif isinstance(msg, proto.Hello):
            refuse(proto.BAD_MESSAGE, "hello already sent")

        elif isinstance(msg, proto.PresenceMsg):
            presence = {
                "type": "presence",
                **client.peer_info(),
                "anchor": msg.anchor.model_dump() if msg.anchor else None,
                "head": msg.head.model_dump() if msg.head else None,
            }
            hub.broadcast(doc_id, presence, exclude_replica=client.replica)
            await fanout.publish(doc_id, presence, exclude_replica=client.replica)

        elif isinstance(msg, proto.OpsMsg):
            if not _take_tokens(client, len(msg.ops), settings.rate_limit_ops_per_sec):
                refuse(proto.RATE_LIMITED, "too many operations, retry shortly")
                continue
            await _store_and_broadcast(msg, client, state, doc_uuid, bound, reply, refuse)

        elif isinstance(msg, proto.SnapshotMsg):
            stored = await oplog.save_snapshot(doc_uuid, msg.up_to_seq, msg.state)
            bound.info("snapshot_upload", up_to_seq=msg.up_to_seq, stored=stored)

        elif isinstance(msg, proto.SyncMsg):
            page = await oplog.ops_since(doc_uuid, msg.last_seq, settings.catchup_page_size)
            head = await oplog.head_seq(doc_uuid)
            more = len(page) == settings.catchup_page_size and page[-1].seq < head
            reply({"type": "catchup", "ops": _ops_payload(page), "more": more, "head_seq": head})


def _take_tokens(client: Client, count: int, per_second: int) -> bool:
    """Token bucket: `per_second` ops/second with a burst of the same size."""
    now = time.monotonic()
    capacity = float(per_second)
    client.tokens = min(capacity, client.tokens + (now - client.last_refill) * per_second)
    client.last_refill = now
    cost = float(count)
    if cost > capacity:
        cost = capacity  # a single huge (but allowed) batch may use the full bucket
    if client.tokens < cost:
        return False
    client.tokens -= cost
    return True


async def _store_and_broadcast(
    msg: proto.OpsMsg,
    client: Client,
    state: dict[str, Any],
    doc_uuid: uuid.UUID,
    bound: Any,
    reply: Any,
    refuse: Any,
) -> None:
    hub: Hub = state["hub"]
    oplog: OperationLog = state["oplog"]
    fanout: Fanout = state["fanout"]
    metrics: Metrics = state["metrics"]
    metrics.batches_total.inc()
    payloads = [op.model_dump(exclude_none=True) for op in msg.ops]
    started = time.perf_counter()
    try:
        result = await oplog.append_batch(doc_uuid, payloads)
    except DocumentNotFoundError:
        refuse(proto.DOC_NOT_FOUND, "document not found")
        return
    except Exception as exc:  # database trouble: no ack, the client keeps its outbox
        bound.error("store_failed", error=repr(exc))
        refuse(proto.INTERNAL, "could not store operations")
        return
    metrics.db_write_seconds.observe(time.perf_counter() - started)
    metrics.ops_total.inc(len(result.new_ops))
    metrics.duplicate_ops_total.inc(result.duplicates)

    reply({"type": "ack", "batch_id": msg.batch_id, "max_seq": result.max_seq})

    if result.new_ops:
        broadcast = {"type": "ops", "ops": _ops_payload(result.new_ops)}
        t0 = time.perf_counter()
        hub.broadcast(client.doc_id, broadcast, exclude_replica=client.replica)
        metrics.broadcast_seconds.observe(time.perf_counter() - t0)
        await fanout.publish(client.doc_id, broadcast, exclude_replica=client.replica)
        bound.info(
            "ops_stored",
            count=len(result.new_ops),
            duplicates=result.duplicates,
            seq=result.max_seq,
        )


async def _handle_remote(
    hub: Hub,
    fanout: Fanout,
    settings: Settings,
    doc_id: str,
    message: dict[str, Any],
    exclude: str | None,
    origin: str,
) -> None:
    """A message published by ANOTHER server process arrived through Redis."""
    kind = message.get("type")
    peers = hub.remote_peers.setdefault(doc_id, {})
    if kind == "peer_joined":
        peers[(origin, message["replica"])] = {
            "replica": message["replica"],
            "name": message.get("name", "Anonymous"),
            "color": message.get("color", "#888888"),
        }
        if message.get("announce"):
            # Tell the newcomer's process about the people connected here.
            for c in hub.room(doc_id).values():
                await fanout.publish(doc_id, {"type": "peer_joined", **c.peer_info()})
        message = {k: v for k, v in message.items() if k != "announce"}
    elif kind == "peer_left":
        peers.pop((origin, message["replica"]), None)
    if not peers:
        hub.remote_peers.pop(doc_id, None)
    hub.broadcast(doc_id, message, exclude_replica=exclude)


# ASGI entry point: `uvicorn app.main:app`
app = create_app()
