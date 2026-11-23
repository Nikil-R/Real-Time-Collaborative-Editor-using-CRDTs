"""Edit activity, collected in memory and flushed in the background.

Recording one database row per stored batch would put extra work on the hot
write path (see docs/results). Instead each stored batch only bumps a counter
here; every few seconds the counters are written as one history entry per
(person, file) and pushed to everyone in the project.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid

import structlog

from .fanout import Fanout
from .hub import Hub
from .projects_store import ProjectStore

log = structlog.get_logger()


def project_room(project_id: uuid.UUID | str) -> str:
    """Hub/Redis room key for a project's realtime channel."""
    return f"project:{project_id}"


class ActivityBuffer:
    def __init__(
        self, store: ProjectStore, hub: Hub, fanout: Fanout, interval_seconds: float
    ) -> None:
        self.store = store
        self.hub = hub
        self.fanout = fanout
        self.interval = interval_seconds
        self._pending: dict[tuple[uuid.UUID, str, uuid.UUID], tuple[str, int]] = {}
        self._task: asyncio.Task[None] | None = None

    def add(
        self, project_id: uuid.UUID, actor: str, file_id: uuid.UUID, file_name: str, count: int
    ) -> None:
        key = (project_id, actor, file_id)
        previous = self._pending.get(key, (file_name, 0))[1]
        self._pending[key] = (file_name, previous + count)

    async def flush(self) -> int:
        """Write everything collected so far. Returns the number of entries written."""
        pending, self._pending = self._pending, {}
        written = 0
        for (project_id, actor, file_id), (file_name, count) in pending.items():
            try:
                event = await self.store.add_edit_activity(
                    project_id, actor, file_id, file_name, count
                )
            except Exception as exc:  # history is best effort; never break editing
                log.warning("activity_write_failed", error=repr(exc))
                continue
            message = {"type": "activity", "event": event}
            room = project_room(project_id)
            self.hub.broadcast(room, message)
            await self.fanout.publish(room, message)
            written += 1
        return written

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        await self.flush()

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            await self.flush()
