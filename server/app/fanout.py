"""Multi-process fan-out through Redis pub/sub (04-PROTOCOL.md section 5).

The database is the source of truth. Redis only speeds delivery to clients
connected to OTHER server processes; a missed message is repaired when the
client next reconnects with its last seq.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

log = structlog.get_logger()

Handler = Callable[[str, dict[str, Any], str | None, str], Awaitable[None]]
"""handler(doc_id, message, exclude_replica, origin_server_id)"""

CHANNEL_PREFIX = "doc:"


class Fanout:
    """No-op fan-out for a single process."""

    enabled = False

    async def start(self, handler: Handler) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def publish(
        self, doc_id: str, message: dict[str, Any], exclude_replica: str | None = None
    ) -> None:
        return None

    async def ping(self) -> bool:
        return True


class RedisFanout(Fanout):
    enabled = True

    def __init__(self, redis: Any, server_id: str) -> None:
        self.redis = redis
        self.server_id = server_id
        self._pubsub: Any = None
        self._task: asyncio.Task[None] | None = None
        self.healthy = True

    async def start(self, handler: Handler) -> None:
        self._pubsub = self.redis.pubsub()
        await self._pubsub.psubscribe(f"{CHANNEL_PREFIX}*")
        self._task = asyncio.create_task(self._listen(handler))

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        if self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.aclose()
        with contextlib.suppress(Exception):
            await self.redis.aclose()

    async def publish(
        self, doc_id: str, message: dict[str, Any], exclude_replica: str | None = None
    ) -> None:
        envelope = {"s": self.server_id, "x": exclude_replica, "m": message}
        try:
            await self.redis.publish(f"{CHANNEL_PREFIX}{doc_id}", json.dumps(envelope))
            self.healthy = True
        except Exception as exc:  # Redis down: single-process delivery still works
            self.healthy = False
            log.warning("redis_publish_failed", error=str(exc))

    async def ping(self) -> bool:
        try:
            await self.redis.ping()
            return True
        except Exception:
            return False

    async def _listen(self, handler: Handler) -> None:
        assert self._pubsub is not None
        while True:
            try:
                async for item in self._pubsub.listen():
                    if item.get("type") != "pmessage":
                        continue
                    channel = item["channel"]
                    channel = channel.decode() if isinstance(channel, bytes) else channel
                    doc_id = channel.removeprefix(CHANNEL_PREFIX)
                    try:
                        envelope = json.loads(item["data"])
                    except (ValueError, TypeError):
                        continue
                    if envelope.get("s") == self.server_id:
                        continue  # our own publish
                    await handler(doc_id, envelope["m"], envelope.get("x"), envelope["s"])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.healthy = False
                log.warning("redis_listen_failed", error=str(exc))
                await asyncio.sleep(1.0)
