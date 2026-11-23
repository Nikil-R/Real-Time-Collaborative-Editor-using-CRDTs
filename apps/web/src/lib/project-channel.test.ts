import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocketLike } from "@rce/client";
import { ProjectChannel, type ChannelHooks } from "./project-channel";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.({}), 0);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const hooks: ChannelHooks = {
    onWelcome: (w) => events.push(`welcome:${w.files.length}:${w.peers.length}`),
    onFilesChanged: (f) => events.push(`files:${f.length}`),
    onPeerJoined: (c) => events.push(`joined:${c.name}`),
    onFocus: (c) => events.push(`focus:${c.name}:${c.file_id}`),
    onPeerLeft: (r) => events.push(`left:${r}`),
    onActivity: (e) => events.push(`activity:${e.kind}`),
    onState: (s) => events.push(`state:${s}`),
  };
  const channel = new ProjectChannel({
    replicaId: "p-1",
    name: "Priya",
    color: "#fff",
    wsUrl: "ws://x/ws/projects/1",
    hooks,
    backoffBaseMs: 100,
    backoffMaxMs: 400,
    random: () => 1,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { channel, sockets, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ProjectChannel", () => {
  it("says hello, reports the welcome and relays events", () => {
    const { channel, sockets, events } = setup();
    channel.start();
    const s = sockets[0]!;
    s.open();
    expect(s.sent[0]).toMatchObject({ type: "hello", v: 1, replica: "p-1", name: "Priya" });
    s.push({ type: "welcome", project: { id: "1", name: "P" }, files: [{}, {}], peers: [{}], activity: [] });
    s.push({ type: "files_changed", files: [{}, {}, {}] });
    s.push({ type: "peer_joined", replica: "p-2", name: "Rahul", color: "#000" });
    s.push({ type: "focus", replica: "p-2", name: "Rahul", color: "#000", file_id: "f1" });
    s.push({ type: "activity", event: { kind: "edit" } });
    s.push({ type: "peer_left", replica: "p-2" });
    expect(events).toEqual([
      "state:connecting",
      "welcome:2:1",
      "state:online",
      "files:3",
      "joined:Rahul",
      "focus:Rahul:f1",
      "activity:edit",
      "left:p-2",
    ]);
  });

  it("sends focus changes and re-sends the last focus after reconnecting", async () => {
    const { channel, sockets } = setup();
    channel.start();
    sockets[0]!.open();
    channel.focus("file-1");
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "focus", file_id: "file-1" });
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(150); // backoff 100 ms
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.push({ type: "welcome", project: { id: "1", name: "P" }, files: [], peers: [], activity: [] });
    expect(sockets[1]!.sent.at(-1)).toEqual({ type: "focus", file_id: "file-1" });
  });

  it("backs off exponentially, capped", async () => {
    const { channel, sockets } = setup();
    channel.start();
    for (let i = 0; i < 5; i++) {
      sockets[i]!.close();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sockets.length).toBeGreaterThanOrEqual(5);
  });

  it("goes offline on request and comes back", async () => {
    const { channel, sockets, events } = setup();
    channel.start();
    sockets[0]!.open();
    channel.setOffline(true);
    expect(events).toContain("state:offline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1); // no reconnect while offline
    channel.setOffline(false);
    expect(sockets).toHaveLength(2);
  });

  it("stops for good when the project does not exist", async () => {
    const { channel, sockets, events } = setup();
    channel.start();
    sockets[0]!.open();
    sockets[0]!.push({ type: "error", code: "DOC_NOT_FOUND", message: "project not found" });
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(events).toContain("state:closed");
  });
});
