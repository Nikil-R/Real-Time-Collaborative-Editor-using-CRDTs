"""Shared fixtures: in-process uvicorn servers and a small WebSocket test client."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import ClientConnection, connect

from app.config import Settings
from app.main import create_app


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class RunningServer:
    def __init__(self, app: Any, port: int, server: uvicorn.Server, settings: Settings) -> None:
        self.app = app
        self.port = port
        self.server = server
        self.settings = settings

    @property
    def http(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws(self) -> str:
        return f"ws://127.0.0.1:{self.port}"


@contextlib.asynccontextmanager
async def run_server(
    settings: Settings, redis_client: Any | None = None
) -> AsyncIterator[RunningServer]:
    app = create_app(settings, redis_client=redis_client)
    port = free_port()
    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", ws_max_size=2**22
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(300):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:
        raise RuntimeError("server did not start")
    try:
        yield RunningServer(app, port, server, settings)
    finally:
        server.should_exit = True
        await task


def database_url_for(tmp_path: Path, name: str = "test.db") -> str:
    """SQLite file per test by default; a real PostgreSQL when TEST_DATABASE_URL is set."""
    return os.environ.get("TEST_DATABASE_URL") or (
        f"sqlite+aiosqlite:///{(tmp_path / name).as_posix()}"
    )


def redis_pair() -> tuple[Any, Any]:
    """Two Redis clients on one (fake or real) Redis, for multi-process tests."""
    url = os.environ.get("TEST_REDIS_URL")
    if url:
        from redis import asyncio as aioredis

        return aioredis.from_url(url), aioredis.from_url(url)
    import fakeredis

    shared = fakeredis.FakeServer()
    return fakeredis.FakeAsyncRedis(server=shared), fakeredis.FakeAsyncRedis(server=shared)


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": database_url_for(tmp_path),
        "auto_create_tables": True,
        "allowed_origins": "*",
        "log_level": "warning",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings_factory(tmp_path: Path) -> Callable[..., Settings]:
    def factory(**overrides: Any) -> Settings:
        return make_settings(tmp_path, **overrides)

    return factory


@pytest.fixture
async def server(settings_factory: Callable[..., Settings]) -> AsyncIterator[RunningServer]:
    async with run_server(settings_factory()) as srv:
        yield srv


class WsClient:
    """Thin wrapper to send/receive JSON objects with a timeout."""

    def __init__(self, conn: ClientConnection) -> None:
        self.conn = conn

    async def send(self, message: dict[str, Any]) -> None:
        await self.conn.send(json.dumps(message))

    async def send_raw(self, raw: str) -> None:
        await self.conn.send(raw)

    async def recv(self, timeout: float = 5.0) -> dict[str, Any]:
        raw = await asyncio.wait_for(self.conn.recv(), timeout)
        return json.loads(raw)  # type: ignore[no-any-return]

    async def recv_type(self, kind: str, timeout: float = 5.0) -> dict[str, Any]:
        """Receive until a message of type `kind` arrives (skipping others)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            msg = await self.recv(max(deadline - loop.time(), 0.01))
            if msg["type"] == kind:
                return msg

    async def expect_silence(self, timeout: float = 0.3) -> None:
        try:
            msg = await self.recv(timeout)
        except TimeoutError:
            return
        raise AssertionError(f"unexpected message {msg}")

    async def close(self) -> None:
        await self.conn.close()


@contextlib.asynccontextmanager
async def open_client(
    srv: RunningServer,
    doc_id: str,
    replica: str,
    *,
    name: str = "Tester",
    last_seq: int = 0,
    hello: bool = True,
) -> AsyncIterator[tuple[WsClient, dict[str, Any] | None]]:
    conn = await connect(f"{srv.ws}/ws/{doc_id}")
    client = WsClient(conn)
    welcome = None
    try:
        if hello:
            await client.send(
                {
                    "type": "hello",
                    "v": 1,
                    "last_seq": last_seq,
                    "replica": replica,
                    "name": name,
                    "color": "#e57373",
                }
            )
            welcome = await client.recv_type("welcome")
        yield client, welcome
    finally:
        await client.close()


async def create_doc(srv: RunningServer) -> str:
    async with httpx.AsyncClient() as http:
        resp = await http.post(f"{srv.http}/api/documents", json={"title": "t"})
        assert resp.status_code == 201
        return str(resp.json()["id"])


def ins(
    replica: str, n: int, clock: int, origin_clock: int = 0, origin_r: str = "", ch: str = "x"
) -> dict[str, Any]:
    return {
        "op_id": {"r": replica, "n": n},
        "kind": "ins",
        "id": {"c": clock, "r": replica},
        "origin": {"c": origin_clock, "r": origin_r},
        "ch": ch,
    }


def dele(replica: str, n: int, target_clock: int, target_r: str) -> dict[str, Any]:
    return {
        "op_id": {"r": replica, "n": n},
        "kind": "del",
        "target": {"c": target_clock, "r": target_r},
    }
