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
import { createSmileServer } from '../src/server/smile-web.js';

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

const port = Number(process.argv[2] ?? process.env.SMILE_PORT ?? 8768);
const { timeseriesClient, metadataClient } = createDefaultDatabentoMcpClients(apiKey);

// Bind to loopback only: this local dev server makes AUTHENTICATED Databento calls, so it must
// not be reachable from the LAN. (Override with SMILE_HOST if you really need to.)
const host = process.env.SMILE_HOST ?? '127.0.0.1';
createSmileServer({ timeseriesClient, metadataClient }).listen(port, host, () => {
  console.log(`smile live server → http://${host}:${port}/smile/CL   (try ?expiry=most-liquid&interval=10)`);
});
