/**
 * live-chain-consumer — a PERSISTENT Databento Live session for a whole option-chain
 * subscription. It reuses the proven transport/CRAM/control-message helpers from live-client.ts
 * (which already talk to the real gateway for single quotes) but, instead of resolving on the
 * first quote, holds the socket open, subscribes to a set of instrument_ids, and streams the raw
 * post-handshake DBN bytes out via onData — fed straight into a LiveSmileFeed. Transport only:
 * decode/buffer/coalesce live in the feed. The socket is injectable for offline tests.
 */
import net from 'node:net';
import {
  computeDatabentoCramResponse,
  getDatabentoLiveGatewayHost,
  parseGatewayControlLine,
  serializeGatewayControl,
  type LiveSocket,
  type LiveSocketFactory,
} from './live-client.js';

const LIVE_CLIENT_ID = 'databento-mcp-server';
const DEFAULT_LIVE_PORT = 13000;
const MAX_SYMBOLS = 2000; // the gateway's per-subscription symbol cap
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000; // CRAM + subscribe must complete within this

export interface LiveChainConsumerOptions {
  apiKey: string;
  dataset?: string;
  port?: number;
  gateway?: string;
  schema?: string; // 'mbp-1' (default) or a bbo schema
  socketFactory?: LiveSocketFactory;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  handshakeTimeoutMs?: number; // fail+recover a socket that connects but never completes CRAM
  onData: (chunk: Buffer) => void; // post-handshake DBN bytes -> LiveSmileFeed.onData
  onOpen?: () => void; // subscribed + streaming
  onError?: (err: Error) => void;
}

function createDefaultSocket({ host, port }: { host: string; port: number }): LiveSocket {
  return net.createConnection({ host, port });
}

export class LiveChainConsumer {
  private readonly apiKey: string;
  private readonly dataset: string;
  private readonly port: number;
  private readonly gateway?: string;
  private readonly schema: string;
  private readonly factory: LiveSocketFactory;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onOpen?: () => void;
  private readonly onError?: (err: Error) => void;

  private socket: LiveSocket | null = null;
  private ids: number[] = [];
  private streaming = false;
  private controlBuffer: Buffer = Buffer.alloc(0);
  private stopped = false;
  private reconnecting = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LiveChainConsumerOptions) {
    this.apiKey = opts.apiKey;
    this.dataset = opts.dataset ?? 'GLBX.MDP3';
    this.port = opts.port ?? DEFAULT_LIVE_PORT;
    this.gateway = opts.gateway;
    this.schema = opts.schema ?? 'mbp-1';
    this.factory = opts.socketFactory ?? createDefaultSocket;
    this.reconnect = opts.reconnect ?? false;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.onData = opts.onData;
    this.onOpen = opts.onOpen;
    this.onError = opts.onError;
  }

  /** Open the session and subscribe to these option/future instrument_ids. */
  start(instrumentIds: number[]): void {
    if (instrumentIds.length > MAX_SYMBOLS) {
      throw new Error(`Live subscription exceeds the ${MAX_SYMBOLS}-symbol cap (${instrumentIds.length} requested)`);
    }
    this.ids = instrumentIds;
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    const host = this.gateway ?? getDatabentoLiveGatewayHost(this.dataset);
    // Retire any prior socket before replacing it so a delayed error/close/end from the DEAD
    // socket can't schedule a second reconnect that tears down the fresh one.
    this.teardownSocket();
    const socket = this.factory({ host, port: this.port });
    this.socket = socket;
    this.streaming = false;
    this.controlBuffer = Buffer.alloc(0);
    // Every handler ignores events from a socket that is no longer the active one (belt-and-braces
    // with teardownSocket's removeAllListeners: a queued event can still fire after replacement).
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.onSocketData(chunk);
    });
    socket.on('error', (err: Error) => {
      if (this.socket !== socket) return;
      this.onError?.(new Error(`Databento Live socket error: ${err.message}`));
      this.scheduleReconnect();
    });
    socket.on('close', () => {
      if (this.socket === socket) this.scheduleReconnect();
    });
    socket.on('end', () => {
      if (this.socket === socket) this.scheduleReconnect();
    });
    this.armHandshakeTimeout(socket);
  }

  /** Detach + destroy the current socket and cancel its handshake watchdog. */
  private teardownSocket(): void {
    this.clearHandshakeTimer();
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null; // detach first so any handler that still fires fails the identity guard
    socket.removeAllListeners();
    // Keep a no-op 'error' sink: a delayed OS error on the retired socket with zero listeners is
    // an unhandled 'error' event, which crashes the process (fatal once this server is hosted in
    // the connector). removeAllListeners drops the stale reconnect handlers; this only swallows.
    socket.on('error', () => {});
    socket.destroy();
  }

  private armHandshakeTimeout(socket: LiveSocket): void {
    if (this.handshakeTimeoutMs <= 0) return;
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.socket !== socket || this.streaming || this.stopped) return;
      this.onError?.(new Error(`Databento Live handshake timed out after ${this.handshakeTimeoutMs}ms`));
      this.teardownSocket();
      this.scheduleReconnect();
    }, this.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private onSocketData(chunk: Buffer): void {
    if (this.streaming) {
      this.onData(chunk);
      return;
    }
    // control lines are newline-delimited and precede the binary DBN stream
    this.controlBuffer = Buffer.concat([this.controlBuffer, chunk]);
    for (;;) {
      const nl = this.controlBuffer.indexOf(0x0a);
      if (nl === -1) return;
      const line = this.controlBuffer.subarray(0, nl + 1);
      const rest = this.controlBuffer.subarray(nl + 1);
      this.handleControl(parseGatewayControlLine(line));
      if (this.streaming) {
        this.controlBuffer = Buffer.alloc(0);
        if (rest.length) this.onData(rest); // DBN bytes that trailed the last control line
        return;
      }
      this.controlBuffer = rest;
    }
  }

  private handleControl(msg: Record<string, string>): void {
    if (!this.socket) return;
    if (msg.cram) {
      this.socket.write(
        serializeGatewayControl({
          auth: computeDatabentoCramResponse(msg.cram, this.apiKey),
          dataset: this.dataset,
          encoding: 'dbn',
          ts_out: '0',
          compression: 'none',
          client: LIVE_CLIENT_ID,
        }),
      );
      return;
    }
    if (msg.success !== undefined) {
      if (msg.success !== '1' && msg.success.toLowerCase() !== 'true') {
        // Auth failure is permanent — reconnecting would hot-loop the same bad credentials and
        // burn metered Live connections. Surface it, mark stopped, and tear the socket down.
        this.onError?.(new Error(`Databento Live authentication failed: ${msg.error || 'unknown error'}`));
        this.stopped = true;
        this.teardownSocket();
        return;
      }
      this.socket.write(
        serializeGatewayControl({ schema: this.schema, stype_in: 'instrument_id', symbols: this.ids.join(','), id: '0', is_last: '1' }),
      );
      this.socket.write(serializeGatewayControl({ start_session: '0' }));
      this.streaming = true;
      this.clearHandshakeTimer(); // handshake completed — cancel the watchdog
      this.onOpen?.();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.reconnect || this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      if (!this.stopped) this.connect();
    }, this.reconnectDelayMs);
  }

  stop(): void {
    this.stopped = true;
    this.socket?.end();
    this.teardownSocket();
  }
}
