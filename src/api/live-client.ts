import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

const DEFAULT_LIVE_DATASET = "GLBX.MDP3";
const DEFAULT_LIVE_PORT = 13000;
const DEFAULT_LIVE_TIMEOUT_MS = 10_000;
const DEFAULT_QUOTE_CACHE_TTL_MS = 1_000;
const LIVE_CLIENT_ID = "databento-mcp-server";
const DBN_PREFIX = "DBN";
const DBN_PRELUDE_LENGTH = 8;
const DBN_RECORD_LENGTH_MULTIPLIER = 4;
const DBN_RECORD_HEADER_LENGTH = 16;
const DBN_RTYPE_MBP_1 = 1;
const DBN_RTYPE_ERROR = 21;
const MBP_1_RECORD_MIN_LENGTH = 80;
const UNDEF_PRICE = 9_223_372_036_854_775_807n;

const LIVE_SYMBOL_MAP: Record<LiveFuturesSymbol, string> = {
  ES: "ES.v.0",
  NQ: "NQ.v.0",
};

export type LiveFuturesSymbol = "ES" | "NQ";

export interface LiveQuoteData {
  symbol: LiveFuturesSymbol;
  liveSymbol: string;
  dataset: string;
  schema: "mbp-1";
  price: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bidCount: number;
  askCount: number;
  timestamp: Date;
  receiveTimestamp: Date;
  dataAge: number;
  sessionId?: string;
}

export interface LiveQuoteOptions {
  timeoutMs?: number;
}

export interface LiveSocket extends EventEmitter {
  write(data: string | Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
}

export type LiveSocketFactory = (options: { host: string; port: number }) => LiveSocket;

export interface DatabentoLiveClientOptions {
  dataset?: string;
  gateway?: string;
  port?: number;
  socketFactory?: LiveSocketFactory;
  now?: () => number;
  quoteCacheTtlMs?: number;
}

type GatewayControlMessage = Record<string, string>;

type DbnDecodeResult =
  | { status: "need-more" }
  | { status: "quote"; quote: Omit<LiveQuoteData, "symbol" | "liveSymbol" | "dataset" | "schema" | "sessionId"> }
  | { status: "gateway-error"; message: string };

export function computeDatabentoCramResponse(challenge: string, apiKey: string): string {
  const bucketId = apiKey.slice(-5);
  const digest = createHash("sha256").update(`${challenge}|${apiKey}`).digest("hex");
  return `${digest}-${bucketId}`;
}

export function getDatabentoLiveGatewayHost(dataset: string): string {
  return `${dataset.toLowerCase().replace(/\./g, "-")}.lsg.databento.com`;
}

function createDefaultSocket({ host, port }: { host: string; port: number }): LiveSocket {
  return net.createConnection({ host, port });
}

function serializeGatewayControl(fields: GatewayControlMessage): string {
  const tokens = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  return `${tokens.join("|")}\n`;
}

function parseGatewayControlLine(line: Buffer): GatewayControlMessage {
  const text = line.toString("utf8").trim();
  const fields: GatewayControlMessage = {};

  for (const token of text.split("|")) {
    const separator = token.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }

  return fields;
}

function unixNanosToDate(nanos: bigint): Date {
  return new Date(Number(nanos / 1_000_000n));
}

function fixedPriceToNumber(price: bigint): number {
  return Number(price) / 1e9;
}

function readNullTerminatedAscii(buffer: Buffer, start: number, end: number): string {
  const nullIndex = buffer.indexOf(0, start);
  const stop = nullIndex >= start && nullIndex < end ? nullIndex : end;
  return buffer.toString("utf8", start, stop).trim();
}

class DbnMbp1QuoteDecoder {
  private buffer = Buffer.alloc(0);
  private metadataSkipped = false;

  write(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  next(now: () => number): DbnDecodeResult {
    const metadataResult = this.skipMetadata();
    if (metadataResult === "need-more") {
      return { status: "need-more" };
    }

    while (this.buffer.length >= DBN_RECORD_HEADER_LENGTH) {
      const recordLength = this.buffer[0] * DBN_RECORD_LENGTH_MULTIPLIER;
      if (recordLength < DBN_RECORD_HEADER_LENGTH) {
        throw new Error(`Invalid DBN record length: ${recordLength}`);
      }
      if (this.buffer.length < recordLength) {
        return { status: "need-more" };
      }

      const record = this.buffer.subarray(0, recordLength);
      this.buffer = this.buffer.subarray(recordLength);
      const rtype = record[1];

      if (rtype === DBN_RTYPE_ERROR) {
        return {
          status: "gateway-error",
          message: readNullTerminatedAscii(record, DBN_RECORD_HEADER_LENGTH, record.length),
        };
      }

      if (rtype !== DBN_RTYPE_MBP_1) {
        continue;
      }

      const quote = parseMbp1QuoteRecord(record, now);
      if (quote) {
        return { status: "quote", quote };
      }
    }

    return { status: "need-more" };
  }

  private skipMetadata(): "ready" | "need-more" {
    if (this.metadataSkipped) {
      return "ready";
    }

    if (this.buffer.length < DBN_PRELUDE_LENGTH) {
      return "need-more";
    }
    if (this.buffer.toString("ascii", 0, 3) !== DBN_PREFIX) {
      throw new Error("Databento Live stream did not start with DBN metadata");
    }

    const metadataLength = this.buffer.readUInt32LE(4);
    const totalMetadataLength = DBN_PRELUDE_LENGTH + metadataLength;
    if (this.buffer.length < totalMetadataLength) {
      return "need-more";
    }

    this.buffer = this.buffer.subarray(totalMetadataLength);
    this.metadataSkipped = true;
    return "ready";
  }
}

function parseMbp1QuoteRecord(
  record: Buffer,
  now: () => number
): Omit<LiveQuoteData, "symbol" | "liveSymbol" | "dataset" | "schema" | "sessionId"> | undefined {
  if (record.length < MBP_1_RECORD_MIN_LENGTH) {
    throw new Error(`Invalid MBP-1 record length: ${record.length}`);
  }

  const bidRaw = record.readBigInt64LE(48);
  const askRaw = record.readBigInt64LE(56);
  if (bidRaw === UNDEF_PRICE || askRaw === UNDEF_PRICE || bidRaw <= 0n || askRaw <= 0n) {
    return undefined;
  }

  const bid = fixedPriceToNumber(bidRaw);
  const ask = fixedPriceToNumber(askRaw);
  const tsEvent = record.readBigUInt64LE(8);
  const tsRecv = record.readBigUInt64LE(32);
  const timestamp = unixNanosToDate(tsEvent);

  return {
    price: (bid + ask) / 2,
    bid,
    ask,
    bidSize: record.readUInt32LE(64),
    askSize: record.readUInt32LE(68),
    bidCount: record.readUInt32LE(72),
    askCount: record.readUInt32LE(76),
    timestamp,
    receiveTimestamp: unixNanosToDate(tsRecv),
    dataAge: now() - timestamp.getTime(),
  };
}

export class DatabentoLiveClient {
  private readonly apiKey: string;
  private readonly dataset: string;
  private readonly gateway: string;
  private readonly port: number;
  private readonly socketFactory: LiveSocketFactory;
  private readonly now: () => number;
  private readonly quoteCacheTtlMs: number;
  private readonly inFlightQuotes = new Map<LiveFuturesSymbol, Promise<LiveQuoteData>>();
  private readonly quoteCache = new Map<LiveFuturesSymbol, { quote: LiveQuoteData; expiresAtMs: number }>();

  constructor(apiKey: string, options: DatabentoLiveClientOptions = {}) {
    if (!apiKey) {
      throw new Error("DATABENTO_API_KEY is required");
    }
    if (!apiKey.startsWith("db-")) {
      throw new Error('DATABENTO_API_KEY must start with "db-"');
    }

    this.apiKey = apiKey;
    this.dataset = options.dataset ?? DEFAULT_LIVE_DATASET;
    this.gateway = options.gateway ?? getDatabentoLiveGatewayHost(this.dataset);
    this.port = options.port ?? DEFAULT_LIVE_PORT;
    this.socketFactory = options.socketFactory ?? createDefaultSocket;
    this.now = options.now ?? (() => Date.now());
    this.quoteCacheTtlMs = options.quoteCacheTtlMs ?? DEFAULT_QUOTE_CACHE_TTL_MS;
  }

  async getLiveFuturesQuote(
    symbol: LiveFuturesSymbol,
    options: LiveQuoteOptions = {}
  ): Promise<LiveQuoteData> {
    const liveSymbol = LIVE_SYMBOL_MAP[symbol];
    if (!liveSymbol) {
      throw new Error(`Invalid live futures symbol: ${symbol}`);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("timeoutMs must be an integer between 1 and 30000");
    }

    const cached = this.quoteCache.get(symbol);
    if (cached && cached.expiresAtMs > this.now()) {
      return cached.quote;
    }

    const inFlight = this.inFlightQuotes.get(symbol);
    if (inFlight) {
      return inFlight;
    }

    const quotePromise = this.readLiveQuote(symbol, liveSymbol, timeoutMs)
      .then((quote) => {
        if (this.quoteCacheTtlMs > 0) {
          this.quoteCache.set(symbol, {
            quote,
            expiresAtMs: this.now() + this.quoteCacheTtlMs,
          });
        }
        return quote;
      })
      .finally(() => {
        this.inFlightQuotes.delete(symbol);
      });

    this.inFlightQuotes.set(symbol, quotePromise);
    return quotePromise;
  }

  private readLiveQuote(
    symbol: LiveFuturesSymbol,
    liveSymbol: string,
    timeoutMs: number
  ): Promise<LiveQuoteData> {
    const socket = this.socketFactory({ host: this.gateway, port: this.port });
    const dbnDecoder = new DbnMbp1QuoteDecoder();
    let controlBuffer = Buffer.alloc(0);
    let sessionId: string | undefined;
    let streaming = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    return new Promise<LiveQuoteData>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        socket.removeListener("end", onClose);
      };

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const fail = (error: Error): void => {
        finish(() => {
          socket.destroy();
          reject(error);
        });
      };

      const handleDbnChunk = (chunk: Buffer): void => {
        try {
          dbnDecoder.write(chunk);
          while (true) {
            const result = dbnDecoder.next(this.now);
            if (result.status === "need-more") {
              return;
            }
            if (result.status === "gateway-error") {
              fail(new Error(`Databento Live gateway error: ${result.message || "unknown error"}`));
              return;
            }

            finish(() => {
              socket.end();
              resolve({
                symbol,
                liveSymbol,
                dataset: this.dataset,
                schema: "mbp-1",
                ...result.quote,
                sessionId,
              });
            });
            return;
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const handleControlMessage = (message: GatewayControlMessage): void => {
        if (message.cram) {
          socket.write(
            serializeGatewayControl({
              auth: computeDatabentoCramResponse(message.cram, this.apiKey),
              dataset: this.dataset,
              encoding: "dbn",
              ts_out: "0",
              compression: "none",
              client: LIVE_CLIENT_ID,
            })
          );
          return;
        }

        if (message.success !== undefined) {
          if (message.success !== "1" && message.success.toLowerCase() !== "true") {
            fail(new Error(`Databento Live authentication failed: ${message.error || "unknown error"}`));
            return;
          }

          sessionId = message.session_id;
          socket.write(
            serializeGatewayControl({
              schema: "mbp-1",
              stype_in: "continuous",
              symbols: liveSymbol,
              id: "0",
              is_last: "1",
            })
          );
          socket.write(serializeGatewayControl({ start_session: "0" }));
          streaming = true;
        }
      };

      const handleControlChunk = (chunk: Buffer): void => {
        controlBuffer = Buffer.concat([controlBuffer, chunk]);

        while (true) {
          const newlineIndex = controlBuffer.indexOf(0x0a);
          if (newlineIndex === -1) {
            return;
          }

          const line = controlBuffer.subarray(0, newlineIndex + 1);
          const rest = controlBuffer.subarray(newlineIndex + 1);
          handleControlMessage(parseGatewayControlLine(line));
          if (streaming) {
            controlBuffer = Buffer.alloc(0);
            handleDbnChunk(rest);
            return;
          }

          controlBuffer = rest;
        }
      };

      const onData = (chunk: Buffer): void => {
        if (streaming) {
          handleDbnChunk(chunk);
        } else {
          handleControlChunk(chunk);
        }
      };

      const onError = (error: Error): void => {
        fail(new Error(`Databento Live socket error: ${error.message}`));
      };

      const onClose = (): void => {
        if (!settled) {
          fail(new Error("Databento Live socket closed before a quote was received"));
        }
      };

      timer = setTimeout(() => {
        fail(new Error(`Databento Live quote timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("end", onClose);
    });
  }
}
