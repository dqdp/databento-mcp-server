/**
 * live-feed — the offline heart of the Live consumer: raw DBN bytes -> framer -> decodeL1Quote
 * -> live buffer -> coalescer -> one rebuilt Chain per flush. Driven by synthetic bytes (no
 * socket), so the whole tick->smile path is unit-tested; the real socket only supplies the bytes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import type { Chain, DefinitionRec, QuoteRec } from '../../../src/analytics/chain.js';
import { LiveSmileFeed } from '../../../src/analytics/live-feed.js';

const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const SIG = 0.2;
const T = 0.2;
const def = (id: number, cls: 'C' | 'P' | 'F', K: number | null): DefinitionRec => ({
  type: 'definition', instrument_id: id, instrument_class: cls, strike: K, expiration: EXP, underlying: cls === 'F' ? '' : String(FUT),
});
const q = (id: number, mid: number): QuoteRec => ({ type: 'quote', instrument_id: id, bid: mid - 0.5, ask: mid + 0.5, ts: null });
const expDefs = [def(201, 'C', 7400), def(202, 'P', 7400), def(203, 'C', 7500), def(204, 'P', 7500)];
const oi = new Map([[201, 1000], [202, 1200], [203, 900], [204, 800]]);
const seedQuotes = [q(FUT, F), q(201, black76(F, 7400, T, SIG, { isCall: true }).price), q(203, black76(F, 7500, T, SIG, { isCall: true }).price)];
const seedOpts = { symbol: 'ES', expiration: EXP, T, window: 20, allExpirations: [EXP], futureDef: def(FUT, 'F', null), expDefs, oi, quotes: seedQuotes };

const prelude = () => { const b = Buffer.alloc(8); b.write('DBN', 0, 'ascii'); b[3] = 2; b.writeUInt32LE(0, 4); return b; };
/** An 80-byte mbp-1 (rtype 1) record for instrument `iid` with mid `mid`. */
function l1(iid: number, mid: number): Buffer {
  const b = Buffer.alloc(80);
  b[0] = 20; // ×4 = 80
  b[1] = 1; // mbp-1
  b.writeUInt32LE(iid, 4);
  b.writeBigInt64LE(BigInt(Math.round((mid - 0.5) * 1e9)), 48);
  b.writeBigInt64LE(BigInt(Math.round((mid + 0.5) * 1e9)), 56);
  return b;
}

describe('LiveSmileFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('folds streamed L1 ticks into the buffer and emits ONE coalesced chain per burst', () => {
    let last: Chain | null = null;
    let flushes = 0;
    const feed = new LiveSmileFeed({ ...seedOpts, coalesceMs: 200, onChain: (c) => { last = c; flushes++; } });

    // a burst: the 7500 call reprices to 0.30 IV, the 7400 call to 0.25
    feed.onData(Buffer.concat([prelude(), l1(203, black76(F, 7500, T, 0.3, { isCall: true }).price)]));
    feed.onData(l1(201, black76(F, 7400, T, 0.25, { isCall: true }).price)); // metadata already skipped

    expect(flushes).toBe(0); // within the coalesce window
    vi.advanceTimersByTime(201);
    expect(flushes).toBe(1); // burst collapsed to one rebuild

    const i = last!.strikes.indexOf(7500);
    const j = last!.strikes.indexOf(7400);
    expect(last!.callIV[i]!).toBeCloseTo(0.3, 2);
    expect(last!.callIV[j]!).toBeCloseTo(0.25, 2);
  });

  it('a future tick moves spot on the next flush', () => {
    let last: Chain | null = null;
    const feed = new LiveSmileFeed({ ...seedOpts, coalesceMs: 100, onChain: (c) => { last = c; } });
    feed.onData(Buffer.concat([prelude(), l1(FUT, 7490)]));
    vi.advanceTimersByTime(101);
    expect(last!.spot).toBe(7490);
  });

  it('ignores non-L1 rtypes without crashing', () => {
    const feed = new LiveSmileFeed({ ...seedOpts, coalesceMs: 100, onChain: () => {} });
    const other = Buffer.alloc(80); other[0] = 20; other[1] = 99; // unknown rtype
    expect(() => feed.onData(Buffer.concat([prelude(), other]))).not.toThrow();
  });
});
