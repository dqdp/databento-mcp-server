/**
 * live-smile-session — ties the Historical seed + LiveSmileFeed + a Live consumer into one
 * object smile-web reads: current() returns the seeded chain immediately, then live ticks (piped
 * from the consumer into the feed) update it. Consumer is injected so this is offline-tested.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import type { DefinitionRec, QuoteRec } from '../../../src/analytics/chain.js';
import type { SeedOpts } from '../../../src/analytics/live-chain.js';
import { LiveSmileSession } from '../../../src/analytics/live-smile-session.js';

const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const T = 0.2;
const def = (id: number, cls: 'C' | 'P' | 'F', K: number | null): DefinitionRec => ({
  type: 'definition', instrument_id: id, instrument_class: cls, strike: K, expiration: EXP, underlying: cls === 'F' ? '' : String(FUT),
});
const qr = (id: number, mid: number): QuoteRec => ({ type: 'quote', instrument_id: id, bid: mid - 0.5, ask: mid + 0.5, ts: null });
const seed: SeedOpts = {
  symbol: 'ES', expiration: EXP, T, window: 20, allExpirations: [EXP],
  futureDef: def(FUT, 'F', null),
  expDefs: [def(201, 'C', 7400), def(202, 'P', 7400), def(203, 'C', 7500), def(204, 'P', 7500)],
  oi: new Map([[201, 1000], [203, 900]]),
  quotes: [qr(FUT, F), qr(201, black76(F, 7400, T, 0.2, { isCall: true }).price), qr(203, black76(F, 7500, T, 0.2, { isCall: true }).price)],
};
const prelude = () => { const b = Buffer.alloc(8); b.write('DBN', 0, 'ascii'); b[3] = 2; b.writeUInt32LE(0, 4); return b; };
function l1(iid: number, mid: number): Buffer {
  const b = Buffer.alloc(80); b[0] = 20; b[1] = 1; b.writeUInt32LE(iid, 4);
  b.writeBigInt64LE(BigInt(Math.round((mid - 0.5) * 1e9)), 48);
  b.writeBigInt64LE(BigInt(Math.round((mid + 0.5) * 1e9)), 56);
  return b;
}

describe('LiveSmileSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('seeds current() immediately and subscribes the consumer to the ids', () => {
    const fake = { start: vi.fn(), stop: vi.fn() };
    const session = new LiveSmileSession(seed, [201, 203, FUT], () => fake, { coalesceMs: 50 });
    expect(session.current()?.spot).toBe(F); // seeded chain available at once
    expect(fake.start).toHaveBeenCalledWith([201, 203, FUT]);
  });

  it('applies a live tick piped from the consumer and updates current()', () => {
    let onData: (chunk: Buffer) => void = () => {};
    const fake = { start: vi.fn(), stop: vi.fn() };
    const session = new LiveSmileSession(seed, [203], (cb) => { onData = cb; return fake; }, { coalesceMs: 50 });

    onData(Buffer.concat([prelude(), l1(203, black76(F, 7500, T, 0.3, { isCall: true }).price)])); // 7500 call -> 0.30
    vi.advanceTimersByTime(60);
    const c = session.current()!;
    expect(c.callIV[c.strikes.indexOf(7500)]!).toBeCloseTo(0.3, 2);
  });

  it('stop() stops the consumer', () => {
    const fake = { start: vi.fn(), stop: vi.fn() };
    const session = new LiveSmileSession(seed, [201], () => fake, {});
    session.stop();
    expect(fake.stop).toHaveBeenCalled();
  });
});
