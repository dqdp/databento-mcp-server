import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DatabentoLiveClient,
  computeDatabentoCramResponse,
  getDatabentoLiveGatewayHost,
  type LiveSocket,
} from "../../../src/api/live-client.js";

class FakeLiveSocket extends EventEmitter implements LiveSocket {
  readonly writes: Buffer[] = [];
  ended = false;
  destroyed = false;

  write(data: string | Uint8Array): boolean {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit("end");
  }

  destroy(error?: Error): void {
    this.destroyed = true;
    if (error) {
      this.emit("error", error);
    }
    this.emit("close");
  }
}

function encodeDbnMetadataPrelude(metadataLength = 120): Buffer {
  const metadata = Buffer.alloc(8 + metadataLength);
  metadata.write("DBN", 0, "ascii");
  metadata.writeUInt8(3, 3);
  metadata.writeUInt32LE(metadataLength, 4);
  return metadata;
}

function encodeMbp1Record(params: {
  tsEventNs: bigint;
  tsRecvNs: bigint;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bidCount: number;
  askCount: number;
}): Buffer {
  const record = Buffer.alloc(80);
  record.writeUInt8(20, 0);
  record.writeUInt8(1, 1);
  record.writeUInt16LE(1, 2);
  record.writeUInt32LE(12345, 4);
  record.writeBigUInt64LE(params.tsEventNs, 8);
  record.writeBigInt64LE(BigInt(Math.round(((params.bid + params.ask) / 2) * 1e9)), 16);
  record.writeUInt32LE(1, 24);
  record.write("M", 28, "ascii");
  record.write("N", 29, "ascii");
  record.writeUInt8(0, 30);
  record.writeUInt8(0, 31);
  record.writeBigUInt64LE(params.tsRecvNs, 32);
  record.writeInt32LE(0, 40);
  record.writeUInt32LE(42, 44);
  record.writeBigInt64LE(BigInt(Math.round(params.bid * 1e9)), 48);
  record.writeBigInt64LE(BigInt(Math.round(params.ask * 1e9)), 56);
  record.writeUInt32LE(params.bidSize, 64);
  record.writeUInt32LE(params.askSize, 68);
  record.writeUInt32LE(params.bidCount, 72);
  record.writeUInt32LE(params.askCount, 76);
  return record;
}

describe("DatabentoLiveClient", () => {
  it("computes the Databento CRAM authentication response", () => {
    expect(computeDatabentoCramResponse("challenge-123", "db-abcdefghijklmnopqrstuvwxyz12345")).toBe(
      "44151f08364aed917587b50ac9df3c58db3fe9937c39ad2d5e7da0584b24dd97-12345"
    );
  });

  it("derives the default live gateway host from the dataset", () => {
    expect(getDatabentoLiveGatewayHost("GLBX.MDP3")).toBe("glbx-mdp3.lsg.databento.com");
  });

  it("authenticates, subscribes to the volume-based continuous front contract, and resolves the first live MBP-1 quote", async () => {
    const socket = new FakeLiveSocket();
    const client = new DatabentoLiveClient("db-abcdefghijklmnopqrstuvwxyz12345", {
      socketFactory: () => socket,
      now: () => Date.parse("2026-06-16T12:00:01.000Z"),
    });

    const quotePromise = client.getLiveFuturesQuote("ES", { timeoutMs: 5_000 });

    socket.emit("data", Buffer.from("lsg_version=1.0.0\ncram=challenge-123\n"));

    await vi.waitFor(() => {
      expect(socket.writes.map((write) => write.toString("utf8"))).toContain(
        "auth=44151f08364aed917587b50ac9df3c58db3fe9937c39ad2d5e7da0584b24dd97-12345|dataset=GLBX.MDP3|encoding=dbn|ts_out=0|compression=none|client=databento-mcp-server\n"
      );
    });

    socket.emit("data", Buffer.from("success=1|session_id=session-1\n"));

    await vi.waitFor(() => {
      expect(socket.writes.map((write) => write.toString("utf8"))).toEqual(
        expect.arrayContaining([
          "schema=mbp-1|stype_in=continuous|symbols=ES.v.0|id=0|is_last=1\n",
          "start_session=0\n",
        ])
      );
    });

    socket.emit(
      "data",
      Buffer.concat([
        encodeDbnMetadataPrelude(),
        encodeMbp1Record({
          tsEventNs: 1_781_611_200_500_000_000n,
          tsRecvNs: 1_781_611_200_600_000_000n,
          bid: 4500.25,
          ask: 4500.5,
          bidSize: 10,
          askSize: 12,
          bidCount: 3,
          askCount: 4,
        }),
      ])
    );

    const quote = await quotePromise;

    expect(quote).toEqual({
      symbol: "ES",
      liveSymbol: "ES.v.0",
      dataset: "GLBX.MDP3",
      schema: "mbp-1",
      bid: 4500.25,
      ask: 4500.5,
      price: 4500.375,
      bidSize: 10,
      askSize: 12,
      bidCount: 3,
      askCount: 4,
      timestamp: new Date("2026-06-16T12:00:00.500Z"),
      receiveTimestamp: new Date("2026-06-16T12:00:00.600Z"),
      dataAge: 500,
      sessionId: "session-1",
    });
    expect(socket.ended).toBe(true);
  });

  it("subscribes NQ quotes to the NQ volume-based continuous front contract", async () => {
    const socket = new FakeLiveSocket();
    const client = new DatabentoLiveClient("db-abcdefghijklmnopqrstuvwxyz12345", {
      socketFactory: () => socket,
      now: () => Date.parse("2026-06-16T12:00:01.000Z"),
    });

    const quotePromise = client.getLiveFuturesQuote("NQ", { timeoutMs: 5_000 });

    socket.emit("data", Buffer.from("lsg_version=1.0.0\ncram=challenge-123\n"));
    socket.emit("data", Buffer.from("success=1|session_id=session-1\n"));

    await vi.waitFor(() => {
      expect(socket.writes.map((write) => write.toString("utf8"))).toContain(
        "schema=mbp-1|stype_in=continuous|symbols=NQ.v.0|id=0|is_last=1\n"
      );
    });

    socket.emit(
      "data",
      Buffer.concat([
        encodeDbnMetadataPrelude(),
        encodeMbp1Record({
          tsEventNs: 1_781_611_200_500_000_000n,
          tsRecvNs: 1_781_611_200_600_000_000n,
          bid: 19000.25,
          ask: 19000.75,
          bidSize: 5,
          askSize: 6,
          bidCount: 2,
          askCount: 3,
        }),
      ])
    );

    await expect(quotePromise).resolves.toEqual(
      expect.objectContaining({
        symbol: "NQ",
        liveSymbol: "NQ.v.0",
        bid: 19000.25,
        ask: 19000.75,
      })
    );
  });

  it("coalesces concurrent quote requests and reuses a short-lived cached quote", async () => {
    const sockets: FakeLiveSocket[] = [];
    const nowMs = Date.parse("2026-06-16T12:00:01.000Z");
    const client = new DatabentoLiveClient("db-abcdefghijklmnopqrstuvwxyz12345", {
      socketFactory: () => {
        const socket = new FakeLiveSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => nowMs,
    });

    const firstQuotePromise = client.getLiveFuturesQuote("ES", { timeoutMs: 5_000 });
    const secondQuotePromise = client.getLiveFuturesQuote("ES", { timeoutMs: 5_000 });

    expect(sockets).toHaveLength(1);
    const socket = sockets[0];

    socket.emit("data", Buffer.from("lsg_version=1.0.0\ncram=challenge-123\n"));
    socket.emit("data", Buffer.from("success=1|session_id=session-1\n"));
    socket.emit(
      "data",
      Buffer.concat([
        encodeDbnMetadataPrelude(),
        encodeMbp1Record({
          tsEventNs: 1_781_611_200_500_000_000n,
          tsRecvNs: 1_781_611_200_600_000_000n,
          bid: 4500.25,
          ask: 4500.5,
          bidSize: 10,
          askSize: 12,
          bidCount: 3,
          askCount: 4,
        }),
      ])
    );

    const [firstQuote, secondQuote] = await Promise.all([firstQuotePromise, secondQuotePromise]);
    expect(secondQuote).toBe(firstQuote);

    const cachedQuote = await client.getLiveFuturesQuote("ES", { timeoutMs: 5_000 });
    expect(cachedQuote).toBe(firstQuote);
    expect(sockets).toHaveLength(1);
  });

  it("returns authentication failures without leaking the API key", async () => {
    const socket = new FakeLiveSocket();
    const client = new DatabentoLiveClient("db-abcdefghijklmnopqrstuvwxyz12345", {
      socketFactory: () => socket,
    });

    const quotePromise = client.getLiveFuturesQuote("NQ", { timeoutMs: 5_000 });

    socket.emit("data", Buffer.from("lsg_version=1.0.0\ncram=challenge-123\n"));
    socket.emit("data", Buffer.from("success=0|error=bad key\n"));

    await expect(quotePromise).rejects.toThrow("Databento Live authentication failed: bad key");
    await expect(quotePromise).rejects.not.toThrow("db-abcdefghijklmnopqrstuvwxyz12345");
  });
});
