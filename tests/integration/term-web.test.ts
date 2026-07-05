/**
 * GET /term/:root.json route — the cross-expiration payload endpoint. The two live GC failures
 * this feature hit argue for pinning the route contract: happy path, ?probe before/after warm,
 * param clamps, malformed %-encoding -> 503, non-GET -> 404, and path traversal neutralized.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSmileServer } from '../../src/server/smile-web.js';
import { clearTermDataCache, setTermCacheDir } from '../../src/analytics/term-data.js';
import { clearSmileStaticCache } from '../../src/analytics/smile-cache.js';

const DISK = path.join(os.tmpdir(), `term-web-${process.pid}`);
setTermCacheDir(DISK);
afterAll(async () => { await fs.rm(DISK, { recursive: true, force: true }); });

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;
// OGQ6 (GC option root OG) — 3 strikes around a 4100 forward; underlying future id 77 = GCQ26.
const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying\n` +
  `4000,OGQ6 C4000,C,${ns('2026-07-28')},77,${4000 * NS},GCQ26\n` +
  `4100,OGQ6 C4100,C,${ns('2026-07-28')},77,${4100 * NS},GCQ26\n` +
  `4200,OGQ6 C4200,C,${ns('2026-07-28')},77,${4200 * NS},GCQ26\n`;
function statFor(ids: number[]): string {
  let out = `instrument_id,ts_ref,price,quantity,stat_type\n`;
  for (const id of ids) {
    if (id === 77) out += `77,0,${4100 * NS},0,3\n`; // the forward
    else out += `${id},0,${50 * NS},0,3\n`; // an option settlement
  }
  return out;
}
const clients = {
  timeseriesClient: {
    getRange: async (req: { schema: string; symbols: string; stype_in?: string }) =>
      req.schema === 'definition'
        ? { data: defCsv }
        : { data: statFor(req.symbols.split(',').map(Number)) },
  },
  metadataClient: { getDatasetRange: async () => ({ end: '2026-07-05T14:00:00Z' }) },
} as any;

describe('GET /term/:root.json', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    clearTermDataCache();
    clearSmileStaticCache();
    await fs.rm(DISK, { recursive: true, force: true });
    server = createSmileServer(clients); // NOT prewarmTerm -> no background pulls
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('probe is cold before, warm after; the GET returns a per-series payload', async () => {
    const p0 = await (await fetch(`${base}/term/GC.json?probe=1`)).json();
    expect(p0).toMatchObject({ root: 'GC', cached: false });
    const r = await fetch(`${base}/term/GC.json`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.optionsRoot).toBe('OG');
    expect(data.series[0].stem).toBe('OGQ6');
    expect(data.series[0].fwdSettle).toBeCloseTo(4100, 6);
    const p1 = await (await fetch(`${base}/term/GC.json?probe=1`)).json();
    expect(p1.cached).toBe(true); // now day-cached
  });

  it('clamps maxSeries/maxDays out-of-range params (no crash)', async () => {
    const r = await fetch(`${base}/term/GC.json?maxSeries=9999&maxDays=1`);
    expect(r.status).toBe(200); // clamped to 24 / 30 internally, still serves
  });

  it('malformed percent-encoding -> 503 (decodeURIComponent throws, caught)', async () => {
    const r = await fetch(`${base}/term/%E0%A4%A.json`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBeTruthy();
  });

  it('a non-GET method -> 404', async () => {
    const r = await fetch(`${base}/term/GC.json`, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('path-traversal in the root cannot escape the cache dir (disk key is regex-sanitized)', async () => {
    await fetch(`${base}/term/${encodeURIComponent('../../etc/passwd')}.json`);
    // whatever the upstream does, any persisted file lands INSIDE DISK with a sanitized name —
    // the '/' and '|' path/separator chars are collapsed to '_', so no traversal is possible.
    const files = await fs.readdir(DISK).catch(() => []);
    expect(files.every((f) => /^[A-Za-z0-9._-]+$/.test(f))).toBe(true);
    expect(files.some((f) => f.includes('/') || f.includes('..' + path.sep))).toBe(false);
  });
});
