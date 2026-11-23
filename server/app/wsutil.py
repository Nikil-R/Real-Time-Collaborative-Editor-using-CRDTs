"""Small WebSocket helpers shared by the document and the project channels."""

from __future__ import annotations

import contextlib
import json

from fastapi import WebSocket

from . import protocol as proto
from .config import Settings
from .metrics import Metrics


class SocketAdapter:
    """Adapts a Starlette WebSocket to the Hub's small Sender protocol."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws

    async def send_text(self, data: str) -> None:
        await self.ws.send_text(data)

    async def close(self, code: int = 1000) -> None:
        await self.ws.close(code)


def origin_allowed(ws: WebSocket, settings: Settings) -> bool:
    origin = ws.headers.get("origin")
    if origin is None or "*" in settings.origins:
        return True  # non-browser clients (load test, scripts) send no Origin
    return origin in settings.origins


async def send_error(ws: WebSocket, metrics: Metrics, code: str, message: str) -> None:
    metrics.errors_total.labels(code=code).inc()
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(proto.error_message(code, message)))
