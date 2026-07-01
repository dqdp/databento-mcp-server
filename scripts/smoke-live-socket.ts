/**
 * OPT-IN live smoke for the Live-SOCKET smile source (real Databento Live gateway; needs
 * DATABENTO_API_KEY + a Live entitlement). Seeds one chain from Historical, opens a persistent
 * Live session on its instrument_ids, watches for ~15s, and reports whether ticks flowed and the
 * chain moved.  npx tsx scripts/smoke-live-socket.ts [ROOT] [expiry|mode]
 */
import { readFileSync } from 'node:fs';
import { createDefaultDatabentoMcpClients } from '../mcp/index.js';
import { LiveChainConsumer } from '../src/api/live-chain-consumer.js';
import { seedLiveFromHistorical } from '../src/analytics/live-seed.js';
import { LiveSmileSession } from '../src/analytics/live-smile-session.js';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const apiKey = process.env.DATABENTO_API_KEY;
if (!apiKey) { console.error('DATABENTO_API_KEY required'); process.exit(1); }

const root = (process.argv[2] ?? 'ES').toUpperCase();
const expiry = process.argv[3];
const clients = createDefaultDatabentoMcpClients(apiKey);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`seeding ${root} from Historical…`);
  const { seed, instrumentIds } = await seedLiveFromHistorical(
    { timeseriesClient: clients.timeseriesClient, metadataClient: clients.metadataClient },
    root,
    { expiry },
  );
  console.log(`seeded ${seed.symbol} exp ${seed.expiration} · subscribing ${instrumentIds.length} instruments`);

  let opened = false;
  let bytes = 0;
  const errors: string[] = [];
  const session = new LiveSmileSession(
    seed,
    instrumentIds,
    (onData) =>
      new LiveChainConsumer({
        apiKey: apiKey!,
        dataset: 'GLBX.MDP3',
        onData: (b) => { bytes += b.length; onData(b); },
        onOpen: () => { opened = true; console.log('LIVE session open — streaming'); },
        onError: (e) => errors.push(e.message),
        reconnect: false,
      }),
    { coalesceMs: 300 },
  );

  const seedSpot = session.current()?.spot;
  const seedAsOf = session.current()?.asOf;
  console.log(`seed spot=${seedSpot} asOf=${seedAsOf} — watching 15s…`);
  await sleep(15000);

  const now = session.current();
  session.stop();
  console.log('\n=== LIVE SOCKET SMOKE ===');
  console.log(`opened:        ${opened}`);
  console.log(`bytes streamed:${bytes}`);
  console.log(`errors:        ${errors.length ? errors.join(' | ') : 'none'}`);
  console.log(`spot seed→now: ${seedSpot} → ${now?.spot}   (moved: ${seedSpot !== now?.spot})`);
  console.log(`asOf seed→now: ${seedAsOf} → ${now?.asOf}`);
  console.log(`ATM IV now:    ${now?.atmIV == null ? 'n/a' : (now.atmIV * 100).toFixed(1) + '%'}`);

  if (!opened) { console.error('\nFAIL: session never opened (CRAM/subscribe/transport)'); process.exit(1); }
  if (bytes === 0) { console.error('\nWARN: opened but zero bytes — market may be closed or subscription empty'); }
  console.log('\nlive socket smoke done.');
}
main().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); });
