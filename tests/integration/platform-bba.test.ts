import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BbaFeed, BBA_BUFFER_SIZE } from "../../src/api/bba-feed.js";
import { BbaSessions } from "../../mcp/bba-sessions.js";
import { listPlatformTools } from "../../mcp/platform-contract.js";

class Socket extends EventEmitter {
  commands: string[] = [];
  closed = false;
  write(value: string) { this.commands.push(value); return true; }
  end() {}
  destroy() { this.closed = true; }
}

const header = Buffer.from([68, 66, 78, 3, 0, 0, 0, 0]);
const missing = 9223372036854775807n;
function quote(bid: bigint, ask: bigint, size = 7) {
  const record = Buffer.alloc(80);
  record[0] = 20;
  record[1] = 1;
  record.writeUInt32LE(123, 4);
  record.writeBigUInt64LE(1795000000000000001n, 8);
  record.writeBigUInt64LE(1795000000000000002n, 32);
  record.writeBigInt64LE(bid, 48);
  record.writeBigInt64LE(ask, 56);
  record.writeUInt32LE(size, 64);
  record.writeUInt32LE(12, 68);
  return record;
}

describe("persistent best bid/ask", () => {
  it("reads changes across calls on one subscription, including size, clears, and signed prices", async () => {
    const socket = new Socket();
    const feed = new BbaFeed({symbol: "ES.v.0", stype_in: "continuous"}, "db-synthetic", () => socket);
    try {
      socket.emit("data", Buffer.from("cram=fixture\nsuccess=1\n"));
      const first = quote(-1000000000n, 0n);
      socket.emit("data", Buffer.concat([header, first, first]));
      const one = await feed.read(0, 1, 0);
      expect(one.data.events).toMatchObject([{cursor: 1, instrument_id: 123, bid: -1, ask: 0, bid_size: 7,
        ts_event_ns: "1795000000000000001", ts_recv_ns: "1795000000000000002"}]);
      expect(Buffer.from(one.originals[0].data_base64, "base64")).toEqual(Buffer.concat([header, first]));
      const pending = feed.read(1, 5, 1000);
      const resize = quote(-1000000000n, 0n, 9);
      const clear = quote(missing, missing);
      socket.emit("data", Buffer.concat([resize, clear.subarray(0, 7)]));
      socket.emit("data", clear.subarray(7));
      expect((await pending).data.events[0]).toMatchObject({cursor: 2, bid_size: 9});
      expect((await feed.read(2, 5, 0)).data.events).toMatchObject([{cursor: 3, bid: null, ask: null}]);
      expect((await feed.read(3, 5, 0)).data.events).toEqual([]);
      expect(socket.commands.filter(s => s.includes("start_session"))).toHaveLength(1);
      expect(socket.commands.join("")).toContain("stype_in=continuous|symbols=ES.v.0");
      socket.emit("end");
      expect((await feed.read(3, 5, 0)).data.status).toBe("upstream_closed");
    } finally { feed.stop(); }
    expect(socket.closed).toBe(true);
  });

  it("advertises a stream separately from the single quote", () => {
    expect(listPlatformTools().map(t => t.name)).toContain("stream_bba");
  });

  it("reports exactly which changes aged out and supports replay within the ring", async () => {
    const socket = new Socket();
    const feed = new BbaFeed({symbol: "123", stype_in: "instrument_id"}, "db-fixture", () => socket);
    try {
      socket.emit("data", Buffer.from("success=1\n"));
      const updates = Array.from({length: BBA_BUFFER_SIZE + 2}, (_, i) => quote(1n, 2n, i));
      socket.emit("data", Buffer.concat([header, ...updates]));
      const first = await feed.read(0, 2, 0);
      expect(first.data).toMatchObject({missed_events: 2, next_cursor: 4, events: [{cursor: 3}, {cursor: 4}]});
      expect(await feed.read(0, 2, 0)).toEqual(first);
      const idle = Date.now();
      const pending = feed.read(BBA_BUFFER_SIZE + 2, 5, 25);
      socket.emit("data", updates[updates.length - 1]);
      expect((await pending).data.events).toHaveLength(0);
      expect(Date.now() - idle).toBeGreaterThanOrEqual(15);
    } finally { feed.stop(); }
  });

  it("binds the handle to the owner and credential revision, caps subscriptions and expires abandoned streams", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const peers = vi.fn(() => ({close, request: async () => ({data: {status: "connecting" as const}, originals: [] as []})}));
    const sessions = new BbaSessions(peers);
    const owner = {sub: "one", workspace: "a".repeat(32), permission: "stream_bba"};
    const input = {name: "stream_bba", api_key: "db-fake", credential_revision: "a".repeat(64)};
    const action = async (args: Record<string, unknown>, claims = owner, rev = input.credential_revision) => {
      const reply = await sessions.call({...input, arguments: args, credential_revision: rev}, claims, new AbortController().signal);
      return JSON.parse((reply.result.content[0] as {text: string}).text);
    };
    try {
      const start = {action: "start", symbol: "ES.c.0", stype_in: "continuous"};
      const {stream_id} = await action(start);
      const stop = {action: "stop", stream_id};
      expect((await action(stop, {...owner, sub: "two"})).status).toBe("unavailable");
      expect((await action(stop, {...owner, workspace: "b".repeat(32)})).status).toBe("unavailable");
      expect(close).not.toHaveBeenCalled();
      await action(start);
      expect((await action(start)).status).toBe("stream_limit");
      expect((await action(stop, owner, "c".repeat(64))).status).toBe("unavailable");
      expect(close).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(45001);
      expect(close).toHaveBeenCalledTimes(2);
      expect(peers).toHaveBeenCalledTimes(2);
    } finally { sessions.close(); vi.useRealTimers(); }
  });
});
