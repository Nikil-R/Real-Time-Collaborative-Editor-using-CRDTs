"""In-process rooms: who is connected to which document, and message delivery.

Each client has a bounded send queue drained by its own writer task. A client
that cannot keep up (queue full) is dropped; it reconnects and resyncs from its
last seen seq (04-PROTOCOL.md section 4, rule 8).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

log = structlog.get_logger()


class Sender(Protocol):
    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int = 1000) -> None: ...


@dataclass(eq=False)
class Client:
    client_id: str
    doc_id: str
    replica: str
    name: str
    color: str
    socket: Sender
    queue: asyncio.Queue[dict[str, Any] | str | None]
    writer: asyncio.Task[None] | None = None
    closed: bool = False
    tokens: float = 0.0
    last_refill: float = 0.0
    dropped: bool = False
    meta: dict[str, Any] = field(default_factory=dict)

    def peer_info(self) -> dict[str, str]:
        return {"replica": self.replica, "name": self.name, "color": self.color}


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, dict[str, Client]] = {}
        # Peers connected to OTHER server processes, learned through Redis.
        self.remote_peers: dict[str, dict[tuple[str, str], dict[str, str]]] = {}

    # --------------------------------------------------------------- rooms

    def room(self, doc_id: str) -> dict[str, Client]:
        return self.rooms.get(doc_id, {})

    def replica_in_use(self, doc_id: str, replica: str) -> bool:
        if any(c.replica == replica for c in self.room(doc_id).values()):
            return True
        return any(p["replica"] == replica for p in self.remote_peers.get(doc_id, {}).values())

    def add(self, client: Client) -> None:
        self.rooms.setdefault(client.doc_id, {})[client.client_id] = client

    def remove(self, client: Client) -> None:
        room = self.rooms.get(client.doc_id)
        if room is not None:
            room.pop(client.client_id, None)
            if not room:
                del self.rooms[client.doc_id]

    @property
    def client_count(self) -> int:
        return sum(len(r) for r in self.rooms.values())

    def peers(self, doc_id: str, exclude_replica: str | None = None) -> list[dict[str, str]]:
        out = [c.peer_info() for c in self.room(doc_id).values()]
        out.extend(self.remote_peers.get(doc_id, {}).values())
        seen: set[str] = set()
        unique: list[dict[str, str]] = []
        for p in out:
            if p["replica"] == exclude_replica or p["replica"] in seen:
                continue
            seen.add(p["replica"])
            unique.append(p)
        return unique

    # ------------------------------------------------------------ delivery

    def enqueue(self, client: Client, message: dict[str, Any] | str) -> bool:
        """Queue a message (a dict, or JSON text already encoded) for one client.

        Returns False if the client was dropped.
        """
        if client.closed:
            return False
        try:
            client.queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            client.dropped = True
            log.warning("client_dropped_slow", doc_id=client.doc_id, replica=client.replica)
            asyncio.get_running_loop().create_task(self._drop(client))
            return False

    async def _drop(self, client: Client) -> None:
        client.closed = True
        with contextlib.suppress(Exception):
            await client.socket.close(1013)  # try again later

    def broadcast(
        self, doc_id: str, message: dict[str, Any], exclude_replica: str | None = None
    ) -> int:
        # Encode once, not once per recipient: with N clients in a room that is
        # N times less JSON work for every stored operation.
        encoded = json.dumps(message, separators=(",", ":"))
        sent = 0
        for client in list(self.room(doc_id).values()):
            if exclude_replica is not None and client.replica == exclude_replica:
                continue
            if self.enqueue(client, encoded):
                sent += 1
        return sent

    # ------------------------------------------------------- writer plumbing

    def start_writer(self, client: Client) -> None:
        client.writer = asyncio.create_task(self._write_loop(client))

    async def _write_loop(self, client: Client) -> None:
        try:
            while True:
                message = await client.queue.get()
                if message is None:
                    return
                text = (
                    message
                    if isinstance(message, str)
                    else json.dumps(message, separators=(",", ":"))
                )
                await client.socket.send_text(text)
        except Exception:  # connection gone; the receive loop will clean up
            client.closed = True

    async def stop_writer(self, client: Client) -> None:
        client.closed = True
        if client.writer is None:
            return
        with contextlib.suppress(asyncio.QueueFull):
            client.queue.put_nowait(None)
        client.writer.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await client.writer
