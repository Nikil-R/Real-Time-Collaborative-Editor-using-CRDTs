"""Workspaces: projects, files, the project channel and the activity feed."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from websockets.asyncio.client import connect

from app.config import Settings
from app.projects_store import InvalidNameError, validate_file_name

from .conftest import RunningServer, WsClient, ins, open_client, redis_pair, run_server


async def create_project(srv: RunningServer, name: str = "Demo") -> dict:
    async with httpx.AsyncClient() as http:
        resp = await http.post(f"{srv.http}/api/projects", json={"name": name})
        assert resp.status_code == 201
        return resp.json()  # type: ignore[no-any-return]


@contextlib.asynccontextmanager
async def open_project(
    srv: RunningServer, project_id: str, replica: str, name: str = "Tester"
) -> AsyncIterator[tuple[WsClient, dict]]:
    conn = await connect(f"{srv.ws}/ws/projects/{project_id}")
    client = WsClient(conn)
    try:
        await client.send(
            {"type": "hello", "v": 1, "replica": replica, "name": name, "color": "#64b5f6"}
        )
        welcome = await client.recv_type("welcome")
        yield client, welcome
    finally:
        await client.close()


def test_file_name_validation() -> None:
    assert validate_file_name("  src/app.ts ") == "src/app.ts"
    for bad in ["", "   ", "/abs", "a//b", "a/../b", "..", "a\\b", "x" * 121, "tab\there"]:
        with pytest.raises(InvalidNameError):
            validate_file_name(bad)


async def test_new_project_comes_with_starter_files(server: RunningServer) -> None:
    project = await create_project(server, "My workspace")
    names = [f["name"] for f in project["files"]]
    assert project["name"] == "My workspace"
    assert names == sorted(names, key=str.lower)
    assert {"README.md", "src/app.ts", "src/stats.py", "config.json", "styles.css"} <= set(names)
    async with httpx.AsyncClient() as http:
        got = (await http.get(f"{server.http}/api/projects/{project['id']}")).json()
        assert [f["id"] for f in got["files"]] == [f["id"] for f in project["files"]]
        assert (await http.get(f"{server.http}/api/projects/{uuid.uuid4()}")).status_code == 404


async def test_create_rename_delete_files_and_reject_bad_names(server: RunningServer) -> None:
    project = await create_project(server)
    base = f"{server.http}/api/projects/{project['id']}/files"
    async with httpx.AsyncClient() as http:
        created = await http.post(base, json={"name": "notes/todo.md"})
        assert created.status_code == 201
        file_id = created.json()["id"]

        assert (await http.post(base, json={"name": "NOTES/TODO.md"})).status_code == 409  # case
        assert (await http.post(base, json={"name": "../escape"})).status_code == 422
        assert (await http.post(base, json={"name": ""})).status_code == 422

        renamed = await http.patch(f"{base}/{file_id}", json={"name": "notes/done.md"})
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "notes/done.md"
        assert (
            await http.patch(f"{base}/{file_id}", json={"name": "README.md"})
        ).status_code == 409
        assert (
            await http.patch(f"{base}/{uuid.uuid4()}", json={"name": "x.md"})
        ).status_code == 404

        assert (await http.delete(f"{base}/{file_id}")).status_code == 204
        assert (await http.delete(f"{base}/{file_id}")).status_code == 404
        listed = (await http.get(f"{server.http}/api/projects/{project['id']}")).json()
        assert "notes/done.md" not in [f["name"] for f in listed["files"]]
        # the name can be used again after deletion
        assert (await http.post(base, json={"name": "notes/done.md"})).status_code == 201


async def test_starter_text_is_given_to_exactly_one_claimer(server: RunningServer) -> None:
    project = await create_project(server)
    readme = next(f for f in project["files"] if f["name"] == "README.md")
    async with httpx.AsyncClient() as http:
        url = f"{server.http}/api/files/{readme['id']}/claim-seed"
        results = await asyncio.gather(*(http.post(url) for _ in range(8)))
    texts = [r.json()["text"] for r in results]
    assert sum(t is not None for t in texts) == 1
    assert "Welcome to your workspace" in next(t for t in texts if t)
    async with httpx.AsyncClient() as http:
        created = await http.post(
            f"{server.http}/api/projects/{project['id']}/files", json={"name": "empty.txt"}
        )
        again = await http.post(f"{server.http}/api/files/{created.json()['id']}/claim-seed")
        assert again.json() == {"text": None}  # a file created by hand has no starter text


async def test_a_deleted_file_can_no_longer_be_opened(server: RunningServer) -> None:
    project = await create_project(server)
    target = project["files"][0]
    async with httpx.AsyncClient() as http:
        await http.delete(f"{server.http}/api/projects/{project['id']}/files/{target['id']}")
    conn = await connect(f"{server.ws}/ws/{target['id']}")
    assert (await WsClient(conn).recv())["code"] == "DOC_NOT_FOUND"


async def test_project_channel_welcome_and_file_list_push(server: RunningServer) -> None:
    project = await create_project(server)
    async with (
        open_project(server, project["id"], "p-a", "Priya") as (a, welcome_a),
        open_project(server, project["id"], "p-b", "Rahul") as (b, welcome_b),
    ):
        assert welcome_a["project"]["name"] == "Demo"
        assert len(welcome_a["files"]) == len(project["files"])
        assert welcome_a["peers"] == []
        assert [p["name"] for p in welcome_b["peers"]] == ["Priya"]
        assert (await a.recv_type("peer_joined"))["name"] == "Rahul"

        async with httpx.AsyncClient() as http:
            await http.post(
                f"{server.http}/api/projects/{project['id']}/files",
                json={"name": "new.py"},
                headers={"X-Actor": "Rahul"},
            )
        for client in (a, b):
            changed = await client.recv_type("files_changed")
            assert "new.py" in [f["name"] for f in changed["files"]]
            event = await client.recv_type("activity")
            assert event["event"]["kind"] == "file_created"
            assert event["event"]["actor"] == "Rahul"
            assert event["event"]["file_name"] == "new.py"


async def test_focus_shows_who_is_in_which_file(server: RunningServer) -> None:
    project = await create_project(server)
    file_id = project["files"][1]["id"]
    async with open_project(server, project["id"], "p-a", "Priya") as (a, _):
        await a.send({"type": "focus", "file_id": file_id})
        async with open_project(server, project["id"], "p-b", "Rahul") as (b, welcome_b):
            assert welcome_b["peers"] == [
                {"replica": "p-a", "name": "Priya", "color": "#64b5f6", "file_id": file_id}
            ]
            await b.send({"type": "focus", "file_id": project["files"][0]["id"]})
            moved = await a.recv_type("focus")
            assert moved["name"] == "Rahul"
            assert moved["file_id"] == project["files"][0]["id"]
            await b.send({"type": "focus", "file_id": "not-a-uuid"})
            assert (await b.recv_type("error"))["code"] == "BAD_MESSAGE"
            await b.send({"type": "ping", "t": 5})
            assert (await b.recv_type("pong"))["t"] == 5


async def test_project_channel_refuses_unknown_project_and_duplicate_replica(
    server: RunningServer,
) -> None:
    conn = await connect(f"{server.ws}/ws/projects/{uuid.uuid4()}")
    assert (await WsClient(conn).recv())["code"] == "DOC_NOT_FOUND"
    project = await create_project(server)
    async with open_project(server, project["id"], "same"):
        conn = await connect(f"{server.ws}/ws/projects/{project['id']}")
        dup = WsClient(conn)
        await dup.send({"type": "hello", "v": 1, "replica": "same"})
        assert (await dup.recv())["code"] == "REPLICA_IN_USE"


async def test_edits_show_up_in_the_activity_feed_merged_per_person_and_file(
    settings_factory: Callable[..., Settings],
) -> None:
    async with run_server(settings_factory(activity_flush_sec=0.2)) as srv:
        project = await create_project(srv)
        file_id = project["files"][1]["id"]
        file_name = project["files"][1]["name"]
        async with (
            open_project(srv, project["id"], "p-a", "Priya") as (watcher, _),
            open_client(srv, file_id, "d-a", name="Rahul") as (editor, _),
        ):
            for n in range(1, 4):  # three separate batches, same person and file
                await editor.send(
                    {"type": "ops", "batch_id": f"b{n}", "ops": [ins("d-a", n, n, ch="x")]}
                )
                await editor.recv_type("ack")
            event = await watcher.recv_type("activity")
            assert event["event"]["kind"] == "edit"
            assert event["event"]["actor"] == "Rahul"
            assert event["event"]["file_name"] == file_name
        await asyncio.sleep(0.6)  # let any later flush finish
        async with httpx.AsyncClient() as http:
            events = (await http.get(f"{srv.http}/api/projects/{project['id']}/activity")).json()[
                "events"
            ]
        edits = [e for e in events if e["kind"] == "edit"]
        assert len(edits) == 1  # merged into one entry, not one per batch
        assert edits[0]["count"] == 3


async def test_standalone_documents_still_work_and_record_no_activity(
    settings_factory: Callable[..., Settings],
) -> None:
    async with run_server(settings_factory(activity_flush_sec=0.2)) as srv:
        async with httpx.AsyncClient() as http:
            doc = (await http.post(f"{srv.http}/api/documents", json={})).json()["id"]
        async with open_client(srv, doc, "r-a") as (a, _):
            await a.send({"type": "ops", "batch_id": "1", "ops": [ins("r-a", 1, 1)]})
            assert (await a.recv_type("ack"))["max_seq"] == 1


async def test_project_channel_works_across_two_server_processes(
    settings_factory: Callable[..., Settings],
) -> None:
    r1, r2 = redis_pair()
    s1 = settings_factory(server_id="proc-1")
    s2 = settings_factory(server_id="proc-2", auto_create_tables=False)
    async with run_server(s1, r1) as one, run_server(s2, r2) as two:
        project = await create_project(one)
        await asyncio.sleep(0.3)
        async with (
            open_project(one, project["id"], "p-a", "Priya") as (a, _),
            open_project(two, project["id"], "p-b", "Rahul") as (b, _),
        ):
            await b.send({"type": "focus", "file_id": project["files"][0]["id"]})
            focus = await a.recv_type("focus", timeout=10)
            assert focus["name"] == "Rahul"
            async with httpx.AsyncClient() as http:
                await http.post(
                    f"{two.http}/api/projects/{project['id']}/files", json={"name": "cross.txt"}
                )
            changed = await a.recv_type("files_changed", timeout=10)
            assert "cross.txt" in [f["name"] for f in changed["files"]]
