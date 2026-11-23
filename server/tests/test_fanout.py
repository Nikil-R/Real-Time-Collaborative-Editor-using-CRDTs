"""Multi-process fan-out through Redis pub/sub (docs/04-PROTOCOL.md section 5).

Two server instances share one database and one (fake) Redis. Clients connected
to different instances must still see each other's edits and presence.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import fakeredis
import httpx

from app.config import Settings

from .conftest import create_doc, ins, open_client, run_server


async def test_clients_on_different_processes_exchange_ops_and_presence(
    settings_factory: Callable[..., Settings],
) -> None:
    redis_server = fakeredis.FakeServer()
    r1 = fakeredis.FakeAsyncRedis(server=redis_server)
    r2 = fakeredis.FakeAsyncRedis(server=redis_server)
    s1 = settings_factory(server_id="proc-1")
    s2 = settings_factory(server_id="proc-2", auto_create_tables=False)
    async with run_server(s1, r1) as one, run_server(s2, r2) as two:
        doc = await create_doc(one)
        await asyncio.sleep(0.2)  # let both psubscribe
        async with (
            open_client(one, doc, "r-a", name="Priya") as (a, _),
            open_client(two, doc, "r-b", name="Rahul") as (b, welcome_b),
        ):
            # Rahul joined on the other process: he learns about Priya, she about him.
            assert welcome_b is not None
            joined = await a.recv_type("peer_joined")
            assert joined["replica"] == "r-b"
            await asyncio.sleep(0.3)

            await a.send({"type": "ops", "batch_id": "1", "ops": [ins("r-a", 1, 1, ch="h")]})
            await a.recv_type("ack")
            got = await b.recv_type("ops")
            assert got["ops"][0]["ch"] == "h"
            assert got["ops"][0]["seq"] == 1

            await b.send({"type": "ops", "batch_id": "2", "ops": [ins("r-b", 1, 2, 1, "r-a", "i")]})
            await b.recv_type("ack")
            got_a = await a.recv_type("ops")
            assert got_a["ops"][0]["ch"] == "i"
            assert got_a["ops"][0]["seq"] == 2  # seq comes from the shared database

            await a.send({"type": "presence", "anchor": {"c": 1, "r": "r-a"}, "head": None})
            pres = await b.recv_type("presence")
            assert pres["replica"] == "r-a"
            assert pres["name"] == "Priya"

        async with open_client(two, doc, "r-c", name="Third") as (_c, welcome_c):
            assert welcome_c is not None
            assert welcome_c["head_seq"] == 2


async def test_new_client_on_second_process_sees_peers_of_the_first(
    settings_factory: Callable[..., Settings],
) -> None:
    redis_server = fakeredis.FakeServer()
    s1 = settings_factory(server_id="proc-1")
    s2 = settings_factory(server_id="proc-2", auto_create_tables=False)
    async with (
        run_server(s1, fakeredis.FakeAsyncRedis(server=redis_server)) as one,
        run_server(s2, fakeredis.FakeAsyncRedis(server=redis_server)) as two,
    ):
        doc = await create_doc(one)
        await asyncio.sleep(0.2)
        async with open_client(one, doc, "r-a", name="Priya") as (_a, _):
            await asyncio.sleep(0.3)
            async with open_client(two, doc, "r-b", name="Rahul") as (b, _):
                # Priya announces herself to the newcomer's process.
                peer = await b.recv_type("peer_joined")
                assert peer["replica"] == "r-a"
                assert peer["name"] == "Priya"
            await asyncio.sleep(0.2)
        # The same replica id cannot be reused across processes while connected.


async def test_same_replica_on_two_processes_is_refused(
    settings_factory: Callable[..., Settings],
) -> None:
    redis_server = fakeredis.FakeServer()
    s1 = settings_factory(server_id="proc-1")
    s2 = settings_factory(server_id="proc-2", auto_create_tables=False)
    async with (
        run_server(s1, fakeredis.FakeAsyncRedis(server=redis_server)) as one,
        run_server(s2, fakeredis.FakeAsyncRedis(server=redis_server)) as two,
    ):
        doc = await create_doc(one)
        await asyncio.sleep(0.2)
        async with open_client(one, doc, "r-a"):
            await asyncio.sleep(0.3)
            async with open_client(two, doc, "r-a", hello=False) as (dup, _):
                await dup.send({"type": "hello", "v": 1, "replica": "r-a"})
                assert (await dup.recv_type("error"))["code"] == "REPLICA_IN_USE"


async def test_health_reports_redis(settings_factory: Callable[..., Settings]) -> None:
    redis = fakeredis.FakeAsyncRedis(server=fakeredis.FakeServer())
    async with run_server(settings_factory(), redis) as srv:
        async with httpx.AsyncClient() as http:
            health = (await http.get(f"{srv.http}/health")).json()
        assert health["redis"] is True
        assert health["status"] == "ok"
