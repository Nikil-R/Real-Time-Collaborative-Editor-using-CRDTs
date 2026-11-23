"""Protocol and relay tests (docs/04-PROTOCOL.md, docs/07-TESTING.md section 4)."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable

import httpx
import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import Settings

from .conftest import RunningServer, create_doc, dele, ins, open_client, run_server


async def test_health_and_create_document(server: RunningServer) -> None:
    async with httpx.AsyncClient() as http:
        health = (await http.get(f"{server.http}/health")).json()
        assert health["status"] == "ok"
        assert health["database"] is True
        assert health["redis"] == "disabled"
        doc = (await http.post(f"{server.http}/api/documents", json={"title": "Notes"})).json()
        uuid.UUID(doc["id"])  # a random UUID, not guessable
        got = (await http.get(f"{server.http}/api/documents/{doc['id']}")).json()
        assert got["title"] == "Notes"
        assert (await http.get(f"{server.http}/api/documents/{uuid.uuid4()}")).status_code == 404


async def test_hello_returns_welcome_with_head_seq(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-1") as (_client, welcome):
        assert welcome is not None
        assert welcome["doc_id"] == doc
        assert welcome["head_seq"] == 0
        assert welcome["ops_since"] == []
        assert welcome["snapshot"] is None
        assert welcome["peers"] == []
        assert welcome["more"] is False


async def test_ops_are_stored_acked_and_broadcast(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with (
        open_client(server, doc, "r-a", name="Priya") as (a, _),
        open_client(server, doc, "r-b", name="Rahul") as (b, _),
    ):
        batch = [ins("r-a", 1, 1, ch="h"), ins("r-a", 2, 2, 1, "r-a", "i")]
        await a.send({"type": "ops", "batch_id": "b-1", "ops": batch})
        ack = await a.recv_type("ack")
        assert ack == {"type": "ack", "batch_id": "b-1", "max_seq": 2}
        got = await b.recv_type("ops")
        assert [o["seq"] for o in got["ops"]] == [1, 2]
        assert got["ops"][0]["ch"] == "h"
        assert got["ops"][1]["origin"] == {"c": 1, "r": "r-a"}
        await a.expect_silence()  # the sender does not get its own ops back


async def test_same_batch_twice_is_acked_but_not_rebroadcast(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with (
        open_client(server, doc, "r-a") as (a, _),
        open_client(server, doc, "r-b") as (b, _),
    ):
        batch = [ins("r-a", 1, 1)]
        await a.send({"type": "ops", "batch_id": "b-1", "ops": batch})
        await a.recv_type("ack")
        await b.recv_type("ops")
        await a.send({"type": "ops", "batch_id": "b-2", "ops": batch})
        ack = await a.recv_type("ack")
        assert ack["batch_id"] == "b-2"
        assert ack["max_seq"] == 1
        await b.expect_silence()


async def test_two_clients_writing_concurrently_never_share_a_seq(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with (
        open_client(server, doc, "r-a") as (a, _),
        open_client(server, doc, "r-b") as (b, _),
    ):

        async def burst(c, replica: str) -> None:
            for i in range(1, 31):
                await c.send(
                    {"type": "ops", "batch_id": f"{replica}-{i}", "ops": [ins(replica, i, i)]}
                )

        await asyncio.gather(burst(a, "r-a"), burst(b, "r-b"))
        seqs: list[int] = []
        for client in (a, b):
            got = 0
            while got < 30:
                msg = await client.recv(5)
                if msg["type"] == "ops":
                    seqs.extend(o["seq"] for o in msg["ops"])
                    got += len(msg["ops"])
        # Each client heard the other's 30 ops; together that is all 60, once each.
        assert len(set(seqs)) == 60
    async with open_client(server, doc, "r-c") as (_c, welcome):
        assert welcome is not None
        assert welcome["head_seq"] == 60
        assert len({o["seq"] for o in welcome["ops_since"]}) == 60


async def test_reconnect_catches_up_from_last_seq(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (a, _):
        await a.send(
            {"type": "ops", "batch_id": "1", "ops": [ins("r-a", i, i) for i in range(1, 6)]}
        )
        await a.recv_type("ack")
    async with open_client(server, doc, "r-b", last_seq=3) as (_b, welcome):
        assert welcome is not None
        assert [o["seq"] for o in welcome["ops_since"]] == [4, 5]
        assert welcome["head_seq"] == 5


async def test_catch_up_pages_with_more_and_sync(settings_factory: Callable[..., Settings]) -> None:
    async with run_server(settings_factory(catchup_page_size=4)) as srv:
        doc = await create_doc(srv)
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send(
                {"type": "ops", "batch_id": "1", "ops": [ins("r-a", i, i) for i in range(1, 11)]}
            )
            await a.recv_type("ack")
        async with open_client(srv, doc, "r-b") as (b, welcome):
            assert welcome is not None
            seqs = [o["seq"] for o in welcome["ops_since"]]
            assert seqs == [1, 2, 3, 4]
            assert welcome["more"] is True
            while True:
                await b.send({"type": "sync", "last_seq": seqs[-1]})
                page = await b.recv_type("catchup")
                seqs.extend(o["seq"] for o in page["ops"])
                if not page["more"]:
                    break
            assert seqs == list(range(1, 11))


async def test_oversized_message_gives_too_large_and_connection_stays_usable(
    settings_factory: Callable[..., Settings],
) -> None:
    async with run_server(settings_factory(max_message_bytes=2000)) as srv:
        doc = await create_doc(srv)
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send_raw(json.dumps({"type": "ping", "t": 1, "pad": "x" * 5000}))
            err = await a.recv_type("error")
            assert err["code"] == "TOO_LARGE"
            await a.send({"type": "ping", "t": 7})
            assert (await a.recv_type("pong"))["t"] == 7


async def test_malformed_input_gives_bad_message_without_crashing(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (a, _):
        for raw in [
            "not json at all",
            "[1, 2, 3]",
            json.dumps({"type": "nope"}),
            json.dumps({"type": "ops", "batch_id": "b", "ops": [{"kind": "ins"}]}),
            json.dumps({"type": "ops", "batch_id": "b", "ops": [ins("r-a", 1, 1) | {"ch": ""}]}),
            json.dumps({"type": "hello", "v": 1, "replica": "r-a"}),
            json.dumps({"type": "presence", "anchor": {"c": -1, "r": "x"}}),
        ]:
            await a.send_raw(raw)
            err = await a.recv_type("error")
            assert err["code"] == "BAD_MESSAGE", raw
        await a.send({"type": "ping", "t": 1})
        await a.recv_type("pong")


async def test_batch_over_the_op_limit_is_rejected(
    settings_factory: Callable[..., Settings],
) -> None:
    async with run_server(settings_factory(max_ops_per_batch=5)) as srv:
        doc = await create_doc(srv)
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send(
                {"type": "ops", "batch_id": "b", "ops": [ins("r-a", i, i) for i in range(1, 7)]}
            )
            err = await a.recv_type("error")
            assert err["code"] == "BAD_MESSAGE"
            assert "too large" in err["message"]


async def test_rate_limit_rejects_bursts_then_recovers(
    settings_factory: Callable[..., Settings],
) -> None:
    async with run_server(settings_factory(rate_limit_ops_per_sec=10)) as srv:
        doc = await create_doc(srv)
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send(
                {"type": "ops", "batch_id": "1", "ops": [ins("r-a", i, i) for i in range(1, 9)]}
            )
            await a.recv_type("ack")
            await a.send(
                {"type": "ops", "batch_id": "2", "ops": [ins("r-a", i, i) for i in range(9, 17)]}
            )
            assert (await a.recv_type("error"))["code"] == "RATE_LIMITED"
            await asyncio.sleep(1.1)  # the bucket refills
            await a.send({"type": "ops", "batch_id": "3", "ops": [ins("r-a", 9, 9)]})
            assert (await a.recv_type("ack"))["batch_id"] == "3"


async def test_unknown_document_is_refused(server: RunningServer) -> None:
    conn = await connect(f"{server.ws}/ws/{uuid.uuid4()}")
    msg = json.loads(await conn.recv())
    assert msg["code"] == "DOC_NOT_FOUND"
    with pytest.raises(ConnectionClosed):
        await conn.recv()
    conn = await connect(f"{server.ws}/ws/not-a-uuid")
    assert json.loads(await conn.recv())["code"] == "DOC_NOT_FOUND"


async def test_first_message_must_be_a_valid_hello(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a", hello=False) as (a, _):
        await a.send({"type": "ping", "t": 1})
        err = await a.recv_type("error")
        assert err["code"] == "BAD_MESSAGE"
    async with open_client(server, doc, "r-a", hello=False) as (a, _):
        await a.send({"type": "hello", "v": 99, "replica": "r-a"})
        err = await a.recv_type("error")
        assert err["code"] == "BAD_MESSAGE"
        assert "version" in err["message"]


async def test_same_replica_cannot_connect_twice(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (_a, _):
        async with open_client(server, doc, "r-a", hello=False) as (dup, _):
            await dup.send({"type": "hello", "v": 1, "replica": "r-a"})
            err = await dup.recv_type("error")
            assert err["code"] == "REPLICA_IN_USE"


async def test_presence_and_peer_events_are_relayed_not_stored(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a", name="Priya") as (a, _):
        async with open_client(server, doc, "r-b", name="Rahul") as (b, welcome_b):
            assert welcome_b is not None
            assert [p["name"] for p in welcome_b["peers"]] == ["Priya"]
            joined = await a.recv_type("peer_joined")
            assert joined["replica"] == "r-b"
            assert joined["name"] == "Rahul"
            await b.send(
                {"type": "presence", "anchor": {"c": 3, "r": "r-a"}, "head": {"c": 5, "r": "r-a"}}
            )
            pres = await a.recv_type("presence")
            assert pres["replica"] == "r-b"
            assert pres["anchor"] == {"c": 3, "r": "r-a"}
            assert pres["name"] == "Rahul"
        left = await a.recv_type("peer_left")
        assert left["replica"] == "r-b"
    async with open_client(server, doc, "r-c") as (_c, welcome):
        assert welcome is not None
        assert welcome["head_seq"] == 0  # presence never reached the database


async def test_ping_pong(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (a, _):
        await a.send({"type": "ping", "t": 1732352000000})
        assert (await a.recv_type("pong"))["t"] == 1732352000000


async def test_snapshot_upload_and_welcome_uses_it(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (a, _):
        ops = [ins("r-a", i, i) for i in range(1, 9)]
        await a.send({"type": "ops", "batch_id": "1", "ops": ops})
        await a.recv_type("ack")
        await a.send({"type": "snapshot", "up_to_seq": 6, "state": {"v": 1, "nodes": []}})
        await asyncio.sleep(0.3)
    # A new client starts from the snapshot and only needs operations after it.
    async with open_client(server, doc, "r-b") as (_b, welcome):
        assert welcome is not None
        assert welcome["snapshot"] == {"up_to_seq": 6, "state": {"v": 1, "nodes": []}}
        assert [o["seq"] for o in welcome["ops_since"]] == [7, 8]
    # A client that already has everything is not sent the snapshot again.
    async with open_client(server, doc, "r-c", last_seq=8) as (_c, welcome):
        assert welcome is not None
        assert welcome["snapshot"] is None
        assert welcome["ops_since"] == []
    async with httpx.AsyncClient() as http:
        snap = (await http.get(f"{server.http}/api/documents/{doc}/snapshot")).json()
        assert snap["up_to_seq"] == 6


async def test_deletes_are_stored_as_opaque_payloads(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with (
        open_client(server, doc, "r-a") as (a, _),
        open_client(server, doc, "r-b") as (b, _),
    ):
        await a.send(
            {
                "type": "ops",
                "batch_id": "1",
                "ops": [ins("r-a", 1, 1), dele("r-a", 2, 1, "r-a")],
            }
        )
        await a.recv_type("ack")
        got = await b.recv_type("ops")
        assert got["ops"][1]["kind"] == "del"
        assert got["ops"][1]["target"] == {"c": 1, "r": "r-a"}


async def test_disallowed_origin_is_rejected(settings_factory: Callable[..., Settings]) -> None:
    async with run_server(settings_factory(allowed_origins="http://localhost:3000")) as srv:
        doc = await create_doc(srv)
        with pytest.raises(Exception):  # noqa: B017 - handshake is refused
            await connect(f"{srv.ws}/ws/{doc}", origin="http://evil.example")
        conn = await connect(f"{srv.ws}/ws/{doc}", origin="http://localhost:3000")
        await conn.close()


async def test_metrics_endpoint_counts_ops(server: RunningServer) -> None:
    doc = await create_doc(server)
    async with open_client(server, doc, "r-a") as (a, _):
        await a.send({"type": "ops", "batch_id": "1", "ops": [ins("r-a", 1, 1)]})
        await a.recv_type("ack")
        async with httpx.AsyncClient() as http:
            text = (await http.get(f"{server.http}/metrics")).text
        assert "collab_ops_total 1.0" in text
        assert "collab_connected_clients 1.0" in text
        assert "collab_db_write_seconds_count 1.0" in text


async def test_server_restart_keeps_acknowledged_ops(
    settings_factory: Callable[..., Settings],
) -> None:
    settings = settings_factory()
    async with run_server(settings) as srv:
        doc = await create_doc(srv)
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send(
                {"type": "ops", "batch_id": "1", "ops": [ins("r-a", i, i) for i in range(1, 4)]}
            )
            assert (await a.recv_type("ack"))["max_seq"] == 3
    async with run_server(settings) as srv2:  # a fresh process, same database
        async with open_client(srv2, doc, "r-a", last_seq=1) as (_a, welcome):
            assert welcome is not None
            assert [o["seq"] for o in welcome["ops_since"]] == [2, 3]
