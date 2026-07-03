/**
 * Local LEVEL-2 live smile server (polled snapshot + per-point update). Opt-in, needs
 * DATABENTO_API_KEY. The futures analogue of `options.py --watch`.
 *
 *   npx tsx scripts/smile-live-server.ts [PORT]
 *   then open  http://localhost:8768/smile/CL             (nearest)
 *              http://localhost:8768/smile/CL?expiry=most-liquid&interval=10
 */
import { readFileSync } from 'node:fs';
import { createDefaultDatabentoMcpClients } from '../mcp/index.js';
import { LiveChainConsumer } from '../src/api/live-chain-consumer.js';
import { createSmileServer, type SmileServerOptions } from '../src/server/smile-web.js';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* rely on ambient env */
}

const apiKey = process.env.DATABENTO_API_KEY;
if (!apiKey) {
  console.error('DATABENTO_API_KEY required (in .env or the environment) for the live smile server');
  process.exit(1);
}

const args = process.argv.slice(2);
const liveMode = args.includes('--live'); // true tick stream via the Live socket; else polled Historical
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.SMILE_PORT ?? 8768);
// Bind to loopback only: this local dev server makes AUTHENTICATED Databento calls AND mints METERED
// live sockets, so it must never be reachable from the LAN. A non-loopback SMILE_HOST is refused outright
// (mirrors smile-web-host.ts) — front it with a reverse proxy if you truly need remote access.
const host = process.env.SMILE_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.error(`refusing SMILE_HOST=${host}: the live smile server is loopback-only (authenticated + metered)`);
  process.exit(1);
}
const { timeseriesClient, metadataClient } = createDefaultDatabentoMcpClients(apiKey);

const options: SmileServerOptions = liveMode
  ? {
      live: {
        makeConsumer: (onData) =>
          new LiveChainConsumer({
            apiKey,
            dataset: 'GLBX.MDP3',
            onData,
            reconnect: true,
            onError: (e) => console.error('[live]', e.message),
          }),
        coalesceMs: 300,
        idleMs: Number(process.env.SMILE_IDLE_MS) || undefined,  // stop a session's metered socket when idle
      },
    }
  : {};

createSmileServer({ timeseriesClient, metadataClient }, options).listen(port, host, () => {
  console.log(`smile ${liveMode ? 'LIVE-socket' : 'polled'} server → http://${host}:${port}/smile/CL   (try ?expiry=most-liquid)`);
});
