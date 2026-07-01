/**
 * smile-web-host — the connector-side glue that OPTIONALLY hosts the live futures-options smile
 * page from inside the MCP server process. It stays OFF by default: only when SMILE_WEB_PORT is
 * set does it start a loopback-bound `createSmileServer` in LIVE-socket mode (a persistent
 * Databento Live session per chain, ticks -> rebuilt smile). This is the connector analogue of
 * `scripts/smile-live-server.ts --live`; the MCP tool surface is unchanged.
 *
 * Kept separate from mcp/index.ts so the env gate + wiring are unit-testable without a stdio MCP
 * server, and injectable (makeConsumer) so the offline gate never opens a real socket.
 */
import type { Server } from 'node:http';
import { LiveChainConsumer } from '../api/live-chain-consumer.js';
import { createSmileServer } from './smile-web.js';
import type { ConsumerFactory } from '../analytics/live-smile-session.js';
import type { SmileClients } from '../analytics/smile-snapshot.js';

const DATASET = 'GLBX.MDP3';
const DEFAULT_COALESCE_MS = 300;
const DEFAULT_HOST = '127.0.0.1'; // loopback only: the page makes AUTHENTICATED Databento calls

/** The smile page serves NO auth, so it may only bind a loopback address. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export interface SmileWebHostOptions {
  env?: Record<string, string | undefined>;
  /** Injectable for tests / alternate transports; defaults to a real Live socket consumer. */
  makeConsumer?: ConsumerFactory;
  host?: string;
}

/** A valid TCP port for `listen`: 0 (ephemeral) through 65535. */
function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/**
 * Start the live smile web server iff SMILE_WEB_PORT is configured; otherwise return null (the
 * default — the connector hosts nothing extra). The returned Server is the caller's to close on
 * shutdown so the Live sockets are torn down with the process.
 */
export function startSmileWebIfConfigured(
  clients: SmileClients,
  apiKey: string,
  opts: SmileWebHostOptions = {},
): Server | null {
  const env = opts.env ?? process.env;
  const port = parsePort(env.SMILE_WEB_PORT);
  if (port === null) {
    if (env.SMILE_WEB_PORT !== undefined && env.SMILE_WEB_PORT.trim() !== '') {
      console.error(`[smile-web] ignoring invalid SMILE_WEB_PORT: ${env.SMILE_WEB_PORT}`);
    }
    return null;
  }

  const host = opts.host ?? env.SMILE_WEB_HOST ?? DEFAULT_HOST;
  // Refuse a non-loopback bind rather than throw (graceful degrade — MCP keeps working). The page
  // is UNAUTHENTICATED and every poll mints a metered Databento Live socket, so LAN exposure would
  // let anyone churn the operator's key. This mirrors mcp/http.ts, which hard-fails non-loopback
  // exposure unless an auth token + TRUST_PROXY are set; the smile surface has no such auth.
  if (!isLoopbackHost(host)) {
    console.error(
      `[smile-web] refusing to host on non-loopback SMILE_WEB_HOST=${host}: the smile page is ` +
        `unauthenticated and opens metered Databento Live sockets. Use 127.0.0.1/localhost/::1 (or a ` +
        `reverse proxy that adds auth).`,
    );
    return null;
  }
  const makeConsumer: ConsumerFactory =
    opts.makeConsumer ??
    ((onData) =>
      new LiveChainConsumer({
        apiKey,
        dataset: DATASET,
        onData,
        reconnect: true,
        onError: (e) => console.error('[smile-web live]', e.message),
      }));

  const server = createSmileServer(clients, { live: { makeConsumer, coalesceMs: DEFAULT_COALESCE_MS } });
  server.on('error', (e) => console.error('[smile-web] server error:', (e as Error).message));
  server.listen(port, host, () => {
    const bound = server.address();
    const shownPort = bound && typeof bound === 'object' ? bound.port : port;
    console.error(`[smile-web] live smile page → http://${host}:${shownPort}/smile/ES  (also CL, GC, NG…)`);
  });
  return server;
}
