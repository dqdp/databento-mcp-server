import { createHash } from "node:crypto";
import { DbnFramer } from "./dbn-framer.js";
import { LiveChainConsumer } from "./live-chain-consumer.js";
import type { LiveSocketFactory } from "./live-client.js";
import type { PlatformOriginal } from "./platform-transport.js";

export const BBA_BUFFER_SIZE = 4096;
export interface BbaSubscription {
  symbol: string;
  stype_in: "raw_symbol" | "continuous" | "instrument_id";
}
type FeedStatus = "connecting" | "streaming" | "upstream_closed" | "upstream_error";
const UNDEF_PRICE = 9223372036854775807n;
const UNDEF_TIME = 18446744073709551615n;
export class InvalidBbaCursor extends Error {}

function price(raw: bigint) { return raw === UNDEF_PRICE ? null : Number(raw) / 1e9; }
function nanos(raw: bigint) { return raw === UNDEF_TIME ? null : raw.toString(); }

function decode(record: Buffer, cursor: number, receivedAt: string) {
  const bid = price(record.readBigInt64LE(48));
  const ask = price(record.readBigInt64LE(56));
  return {cursor, publisher_id: record.readUInt16LE(2), instrument_id: record.readUInt32LE(4),
    ts_event_ns: nanos(record.readBigUInt64LE(8)), ts_recv_ns: nanos(record.readBigUInt64LE(32)),
    received_at: receivedAt, bid, ask, bid_size: bid === null ? null : record.readUInt32LE(64),
    ask_size: ask === null ? null : record.readUInt32LE(68), sequence: record.readUInt32LE(44), flags: record[30]};
}

/** One socket and one ring per stream. Only records that change L1 prices or sizes are retained. */
export class BbaFeed {
  private readonly framer = new DbnFramer();
  private readonly consumer: LiveChainConsumer;
  private readonly ring: {record: Buffer; receivedAt: string}[] = new Array(BBA_BUFFER_SIZE);
  private cursor = 0;
  private status: FeedStatus = "connecting";
  private wake?: () => void;

  constructor(private readonly subscription: BbaSubscription, private readonly apiKey: string, socketFactory?: LiveSocketFactory) {
    this.consumer = new LiveChainConsumer({apiKey, socketFactory, reconnect: false,
      onData: chunk => this.accept(chunk), onError: () => this.finish("upstream_error"),
      onClose: () => this.finish("upstream_closed")});
    this.consumer.startSymbol(subscription.symbol, subscription.stype_in);
  }

  private finish(status: FeedStatus) {
    if (this.status === "upstream_error" || this.status === "upstream_closed") return;
    this.status = status;
    this.consumer.stop();
    this.wake?.();
  }

  private accept(chunk: Buffer) {
    try {
      const previousCursor = this.cursor;
      const receivedAt = new Date().toISOString();
      this.framer.write(chunk);
      for (const record of this.framer.records()) {
        if (record[1] === 21) { this.finish("upstream_error"); return; }
        if (record[1] !== 1) continue;
        if (record.length < 80) throw new Error("Invalid MBP-1");
        const previous = this.cursor ? this.ring[(this.cursor - 1) % BBA_BUFFER_SIZE].record : undefined;
        // Compare the exact fixed-point prices and sizes, including UNDEF and instrument rolls.
        if (previous && record.subarray(2, 8).equals(previous.subarray(2, 8)) &&
            record.subarray(48, 72).equals(previous.subarray(48, 72))) continue;
        this.ring[this.cursor % BBA_BUFFER_SIZE] = {record: Buffer.from(record), receivedAt};
        this.cursor++;
      }
      if (this.framer.metadata) this.status = "streaming";
      if (this.cursor !== previousCursor) this.wake?.();
    } catch { this.finish("upstream_error"); }
  }

  async read(after: number, limit: number, waitMs: number) {
    if (after > this.cursor) throw new InvalidBbaCursor("Cursor beyond stream");
    if (this.wake) throw new Error("Concurrent stream read");
    if (after === this.cursor && waitMs && (this.status === "connecting" || this.status === "streaming")) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
        const timer = setTimeout(done, waitMs);
        this.wake = done;
      });
    }
    const first = Math.max(after + 1, this.cursor - BBA_BUFFER_SIZE + 1);
    const last = Math.min(this.cursor, first + limit - 1);
    const events: ReturnType<typeof decode>[] = [];
    const records: Buffer[] = [];
    for (let cursor = first; cursor <= last; cursor++) {
      const {record, receivedAt} = this.ring[(cursor - 1) % BBA_BUFFER_SIZE];
      events.push(decode(record, cursor, receivedAt));
      records.push(record);
    }
    const originals: PlatformOriginal[] = [];
    if (records.length) {
      const bytes = Buffer.concat([this.framer.metadata!, ...records]);
      if (bytes.includes(Buffer.from(this.apiKey))) throw new Error("Invalid DBN contents");
      originals.push({name: "bba-records.dbn", media_type: "application/octet-stream", representation: "selected_live_dbn",
        data_base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"),
        received_at: events[events.length - 1].received_at, request: {endpoint: "live.subscribe",
          parameters: {dataset: "GLBX.MDP3", schema: "mbp-1", symbols: this.subscription.symbol, stype_in: this.subscription.stype_in}}});
    }
    return {data: {...this.subscription, dataset: "GLBX.MDP3", schema: "mbp-1", status: this.status, events,
      next_cursor: events.at(-1)?.cursor ?? after, latest_cursor: this.cursor, missed_events: first - after - 1}, originals};
  }

  stop() { this.finish("upstream_closed"); }
}
