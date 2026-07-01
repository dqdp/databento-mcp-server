/**
 * Black-76 pricer / greeks / implied-vol solver — unit tests.
 *
 * Node port of the Python greeks.py checks (market_data_skill/scripts/test_greeks.py),
 * futures-only (Black-76). TDD step 1 of the futures-options live analytics: the per-tick
 * IV solve must be cheap, so the solver warm-starts from the previous tick's IV.
 */
import { describe, it, expect } from 'vitest';
import { black76, impliedVol } from '../../../src/analytics/black76.js';

const F = 7467;
const T = 0.0282;

describe('black76 pricer + greeks', () => {
  it('prices a call/put with sane greeks', () => {
    const c = black76(F, 7575, T, 0.13, { isCall: true });
    expect(c.price).toBeGreaterThan(0);
    expect(c.delta).toBeGreaterThan(0);
    expect(c.delta).toBeLessThan(1);
    expect(c.vega).toBeGreaterThan(0);
    expect(c.gamma).toBeGreaterThan(0);
    const p = black76(F, 7575, T, 0.13, { isCall: false });
    expect(p.delta).toBeLessThan(0);
  });

  it('put-call parity: C - P = DF*(F - K)', () => {
    const r = 0.05;
    const K = 7400;
    const c = black76(F, K, T, 0.15, { isCall: true, r });
    const p = black76(F, K, T, 0.15, { isCall: false, r });
    const df = Math.exp(-r * T);
    expect(c.price - p.price).toBeCloseTo(df * (F - K), 5);
  });
});

describe('impliedVol (Newton + bisection, warm-start)', () => {
  const K = 7575;
  const trueSig = 0.13;
  const px = black76(F, K, T, trueSig, { isCall: true }).price;

  it('cold solve recovers sigma', () => {
    const { sigma } = impliedVol(px, K, T, { F, isCall: true });
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeCloseTo(trueSig, 5);
  });

  it('warm-start: strictly fewer iters than cold, same answer', () => {
    const cold = impliedVol(px, K, T, { F, isCall: true });
    const warm = impliedVol(px, K, T, { F, isCall: true, guess: 0.131 });
    expect(warm.sigma!).toBeCloseTo(cold.sigma!, 9);
    expect(warm.iters).toBeLessThan(cold.iters);
    expect(warm.iters).toBeLessThanOrEqual(4);
  });

  it('exact guess converges in a single iteration', () => {
    const r = impliedVol(px, K, T, { F, isCall: true, guess: trueSig });
    expect(r.iters).toBe(1);
    expect(r.sigma!).toBeCloseTo(trueSig, 6);
  });

  it('an out-of-bracket guess is ignored, still solves', () => {
    const r = impliedVol(px, K, T, { F, isCall: true, guess: 99 });
    expect(r.sigma!).toBeCloseTo(trueSig, 5);
  });

  it('price below intrinsic -> null (iters 0)', () => {
    const r = impliedVol(0.0001, 7000, 0.001, { F: 7510, isCall: true });
    expect(r.sigma).toBeNull();
    expect(r.iters).toBe(0);
  });
});

describe('black76 + impliedVol edge branches', () => {
  it('black76 throws on non-positive F/K/T/sigma', () => {
    expect(() => black76(0, 7500, T, 0.2)).toThrow();
    expect(() => black76(F, 0, T, 0.2)).toThrow();
    expect(() => black76(F, 7500, 0, 0.2)).toThrow();
    expect(() => black76(F, 7500, T, 0)).toThrow();
  });

  it('recovers PUT-side implied vol', () => {
    const K = 7400;
    const sig = 0.18;
    const px = black76(F, K, T, sig, { isCall: false }).price;
    const { sigma } = impliedVol(px, K, T, { F, isCall: false });
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeCloseTo(sig, 5);
  });

  it('recovers a moderately-OTM call IV (well-determined: price >> tol)', () => {
    // NB: a FAR-OTM short-dated option prices below the solver's absolute tol (1e-8), so its
    // IV is ill-determined (the flat region many sigmas satisfy) — the same degeneracy as a
    // deep-ITM "trading at intrinsic" contract. Use a moderately-OTM strike where IV is real.
    const K = 7700;
    const sig = 0.25;
    const px = black76(F, K, T, sig, { isCall: true }).price;
    const { sigma } = impliedVol(px, K, T, { F, isCall: true });
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeCloseTo(sig, 5);
  });

  it('a price at/above the 5.0-vol bound returns the bracket cap (iters 0)', () => {
    const K = 7500;
    const hiPx = black76(F, K, T, 5.0, { isCall: true }).price;
    const r = impliedVol(hiPx + 100, K, T, { F, isCall: true });
    expect(r.sigma).toBe(5.0);
    expect(r.iters).toBe(0);
  });
});
