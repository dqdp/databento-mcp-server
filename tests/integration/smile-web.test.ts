/**
 * smile-web — the LEVEL-2 live smile server. Hits the real routes over HTTP with mock Databento
 * clients (canned CSV), asserting the JSON snapshot route and the live page (poll + interval).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSmileServer, MAX_LIVE_SESSIONS } from '../../src/server/smile-web.js';
import { black76 } from '../../src/analytics/black76.js';
import { clearSmileStaticCache } from '../../src/analytics/smile-cache.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();
const TODAY = '2026-06-30';
const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const SIG = 0.2;
const T = (Date.parse(`${EXP}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000 / 365;

let defCsv = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n`;
let bboCsv = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
let statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n`;
let id = 201;
for (const K of [7400, 7500]) {
  for (const isCall of [true, false]) {
    const cls = isCall ? 'C' : 'P';
    defCsv += `${id},ES ${cls}${K},${cls},${ns(EXP)},${FUT},${K * 1e9}\n`;
    const p = Math.round(black76(F, K, T, SIG, { isCall }).price * 1e9);
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
  metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
} as any;

describe('smile-web server', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    clearSmileStaticCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-30T14:00:00Z'));
    server = createSmileServer(clients);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /smile/:root.json returns a fresh snapshot chain', async () => {
    const res = await fetch(`${base}/smile/ES.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const chain = await res.json();
    expect(chain.symbol).toBe('ES');
    expect(chain.expiration).toBe(EXP);
    expect(chain.strikes).toEqual([7400, 7500]);
    expect(chain.callIV.some((v: number | null) => typeof v === 'number')).toBe(true);
  });

  it('GET /smile/:root returns the live page (poll loop + interval selector at the requested interval)', async () => {
    const res = await fetch(`${base}/smile/ES?interval=30`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/smile/ES.json'); // polls the JSON route
    expect(html).toMatch(/<select[^>]*id="iv"/);
    expect(html).toMatch(/value="30"[^>]*selected/); // interval from the query
    expect(html).toMatch(/LIVE/);
  });

  it('a failing snapshot surfaces as 503 JSON, not a crash', async () => {
    const failing = {
      timeseriesClient: {
        // valid defs/stats but an EMPTY bbo window -> no forward (market-closed path)
        getRange: async (req: { schema: string }) => ({
          data:
            req.schema === 'definition'
              ? defCsv
              : req.schema === 'statistics'
                ? statCsv
                : `instrument_id,ts_event,bid_px_00,ask_px_00\n`,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    const s = createSmileServer(failing);
    await new Promise<void>((r) => s.listen(0, r));
    try {
      const res = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/smile/ES.json`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/no options|no forward|market|no bbo/i);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('clamps a crafted oversized window (no runaway pull)', async () => {
    const res = await fetch(`${base}/smile/ES.json?window=999999`);
    expect(res.status).toBe(200); // window clamped to <=200, request still succeeds
    expect((await res.json()).strikes).toEqual([7400, 7500]);
  });

  it('unknown path -> 404', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('live mode serves the Live buffer (seeded from Historical, then updated by a piped tick)', async () => {
    const preludeBytes = () => { const b = Buffer.alloc(8); b.write('DBN', 0, 'ascii'); b[3] = 2; b.writeUInt32LE(0, 4); return b; };
    const l1rec = (iid: number, mid: number) => {
      const b = Buffer.alloc(80); b[0] = 20; b[1] = 1; b.writeUInt32LE(iid, 4);
      b.writeBigInt64LE(BigInt(Math.round((mid - 0.5) * 1e9)), 48);
      b.writeBigInt64LE(BigInt(Math.round((mid + 0.5) * 1e9)), 56);
      return b;
    };
    let feedOnData: (chunk: Buffer) => void = () => {};
    const fakeConsumer = { start: () => {}, stop: () => {} };
    const live = createSmileServer(clients, { live: { makeConsumer: (cb) => { feedOnData = cb; return fakeConsumer; }, coalesceMs: 20 } });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const c1 = await (await fetch(`${b}/smile/ES.json`)).json();
      expect(c1.symbol).toBe('ES');
      expect(c1.spot).toBe(F); // seeded from the Historical snapshot at once

      // pipe a live tick straight into the session's feed: 7500 call reprices to 0.30 IV
      feedOnData(Buffer.concat([preludeBytes(), l1rec(203, black76(F, 7500, T, 0.3, { isCall: true }).price)]));
      await new Promise((r) => setTimeout(r, 60)); // let the coalescer flush (real timer)

      const c2 = await (await fetch(`${b}/smile/ES.json`)).json();
      expect(c2.callIV[c2.strikes.indexOf(7500)]).toBeCloseTo(0.3, 2);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode dedups concurrent first-polls for one key into a single session (no orphaned socket)', async () => {
    // P1: two overlapping cold polls must not each open (and orphan) an authenticated Live socket.
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const [c1, c2] = await Promise.all([
        fetch(`${b}/smile/ES.json`).then((r) => r.json()),
        fetch(`${b}/smile/ES.json`).then((r) => r.json()),
      ]);
      expect(c1.symbol).toBe('ES');
      expect(c2.symbol).toBe('ES');
      expect(consumers).toBe(1); // in-flight construction deduped
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode collapses equivalent expiry selectors (nearest / NEAREST / absent) onto one session', async () => {
    // P2: the session key must normalize the expiry selector, else the same expiration opens
    // several live sockets.
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      await (await fetch(`${b}/smile/ES.json`)).json(); // absent -> nearest
      await (await fetch(`${b}/smile/ES.json?expiry=nearest`)).json();
      await (await fetch(`${b}/smile/ES.json?expiry=NEAREST`)).json();
      expect(consumers).toBe(1); // one session for all three
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('a gateway ERROR record evicts the poisoned session so a later poll re-seeds', async () => {
    // P1: an rtype-21 ERROR latches the session error; the key must be evicted + torn down so the
    // next poll re-seeds, not wedged into a permanent 503 with the socket still held.
    const prelude = () => { const p = Buffer.alloc(8); p.write('DBN', 0, 'ascii'); p[3] = 2; p.writeUInt32LE(0, 4); return p; };
    const errRec = (msg: string) => {
      const body = Buffer.from(msg, 'ascii');
      const total = Math.ceil((16 + body.length + 1) / 4) * 4;
      const rb = Buffer.alloc(total); rb[0] = total / 4; rb[1] = 21; body.copy(rb, 16); return rb;
    };
    let feedOnData: (chunk: Buffer) => void = () => {};
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: (cb) => { feedOnData = cb; consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      expect((await (await fetch(`${b}/smile/ES.json`)).json()).symbol).toBe('ES');
      expect(consumers).toBe(1);
      feedOnData(Buffer.concat([prelude(), errRec('subscription rejected')])); // gateway rejects
      const bad = await fetch(`${b}/smile/ES.json`);
      expect(bad.status).toBe(503);
      expect((await (await fetch(`${b}/smile/ES.json`)).json()).symbol).toBe('ES'); // re-seeded
      expect(consumers).toBe(2); // a fresh session, not the poisoned one
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('bounds the live-session map and stops sessions evicted by the cap', async () => {
    // P2: one persistent socket per key, never evicted, is a resource leak. Cap the map (LRU).
    const stops: number[] = [];
    let created = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { const seq = created++; return { start() {}, stop() { stops.push(seq); } }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const n = MAX_LIVE_SESSIONS + 8;
      for (let w = 1; w <= n; w++) await (await fetch(`${b}/smile/ES.json?window=${w}`)).json(); // distinct keys
      expect(created).toBe(n);
      expect(stops).toHaveLength(n - MAX_LIVE_SESSIONS); // oldest evicted + stopped
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('idle sweeper stops the metered socket when nobody polls, and re-seeds on the next poll', async () => {
    // The money-safety path: when the dashboard closes and polling stops, the metered Live socket must be
    // torn down (not left streaming), then re-seeded on the next poll. Fake setInterval (the sweeper) but
    // leave setTimeout real so undici's fetch + the coalescer still work.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-06-30T14:00:00Z'));
    let started = 0;
    const stops: number[] = [];
    const live = createSmileServer(clients, {
      live: {
        makeConsumer: () => { const seq = started++; return { start() {}, stop() { stops.push(seq); } }; },
        coalesceMs: 20,
        idleMs: 15_000, // clamped to the 15s floor; sweep period = min(15s, IDLE_MS) = 15s
      },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      await (await fetch(`${b}/smile/ES.json`)).json(); // opens session #0 + its socket
      expect(started).toBe(1);
      expect(stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(31_000); // > IDLE_MS + one sweep, with nobody polling
      expect(stops).toEqual([0]); // the idle metered socket was stopped
      await (await fetch(`${b}/smile/ES.json`)).json(); // next poll re-seeds a fresh socket
      expect(started).toBe(2);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });
});
