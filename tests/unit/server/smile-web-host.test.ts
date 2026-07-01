/**
 * smile-web-host — the connector-side helper that OPTIONALLY hosts the live smile page when
 * SMILE_WEB_PORT is set. Verifies the env gate (off by default), loopback bind, and that a
 * configured port serves the seeded chain (delegating to the already-tested createSmileServer).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startSmileWebIfConfigured } from '../../../src/server/smile-web-host.js';
import { black76 } from '../../../src/analytics/black76.js';
import { clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();
const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const T = (Date.parse(`${EXP}T00:00:00Z`) - Date.now()) / 86_400_000 / 365;

let defCsv = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n`;
let bboCsv = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
let statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n`;
let id = 201;
for (const K of [7400, 7500]) {
  for (const isCall of [true, false]) {
    const cls = isCall ? 'C' : 'P';
    defCsv += `${id},ES ${cls}${K},${cls},${ns(EXP)},${FUT},${K * 1e9}\n`;
    const p = Math.round(black76(F, K, T, 0.2, { isCall }).price * 1e9);
    bboCsv += `${id},1,${p - 500000000},${p + 500000000}\n`;
    statCsv += `${id},0,0,1000,9\n`;
    id++;
  }
}

const clients = {
  timeseriesClient: {
    getRange: async (req: { schema: string }) => ({
      data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : bboCsv,
    }),
  },
  metadataClient: { getDatasetRange: async () => ({ end: new Date().toISOString() }) },
} as any;

describe('startSmileWebIfConfigured', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    clearSmileStaticCache();
  });

  it('does not host when SMILE_WEB_PORT is unset (default off)', () => {
    server = startSmileWebIfConfigured(clients, 'key', { env: {} });
    expect(server).toBeNull();
  });

  it('does not host when SMILE_WEB_PORT is not a valid port', () => {
    expect(startSmileWebIfConfigured(clients, 'key', { env: { SMILE_WEB_PORT: 'abc' } })).toBeNull();
    expect(startSmileWebIfConfigured(clients, 'key', { env: { SMILE_WEB_PORT: '70000' } })).toBeNull();
  });

  it('hosts the live smile page on the configured port (loopback), serving the seeded chain', async () => {
    clearSmileStaticCache();
    server = startSmileWebIfConfigured(clients, 'key', {
      env: { SMILE_WEB_PORT: '0' }, // ephemeral for the test
      makeConsumer: () => ({ start() {}, stop() {} }), // no real socket in the offline gate
    });
    expect(server).not.toBeNull();
    await new Promise<void>((r) => (server!.listening ? r() : server!.once('listening', () => r())));
    const addr = server!.address() as AddressInfo;
    expect(addr.address === '127.0.0.1' || addr.address === '::ffff:127.0.0.1').toBe(true); // loopback only

    const res = await fetch(`http://127.0.0.1:${addr.port}/smile/ES.json`);
    expect(res.status).toBe(200);
    const chain = await res.json();
    expect(chain.symbol).toBe('ES');
    expect(chain.spot).toBe(F); // seeded from the Historical snapshot at once
  });
});
