/**
 * coalescer — a render throttle (NOT a data poll): many live ticks within a short window
 * trigger ONE flush (rebuild + diff), carrying the union of changed strikes (tracked on the
 * live buffer). A maxWait bounds latency so a continuous stream still flushes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Coalescer } from '../../../src/analytics/coalescer.js';

describe('Coalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of marks within the window into a single flush', () => {
    let flushes = 0;
    const c = new Coalescer(200, () => flushes++);
    c.mark(); c.mark(); c.mark();
    vi.advanceTimersByTime(199);
    expect(flushes).toBe(0); // still within the debounce window
    vi.advanceTimersByTime(2);
    expect(flushes).toBe(1); // one flush for the whole burst
  });

  it('starts a fresh window after a flush', () => {
    let flushes = 0;
    const c = new Coalescer(200, () => flushes++);
    c.mark();
    vi.advanceTimersByTime(201);
    expect(flushes).toBe(1);
    c.mark();
    vi.advanceTimersByTime(201);
    expect(flushes).toBe(2);
  });

  it('maxWait bounds latency under a continuous stream (flushes without idle)', () => {
    let flushes = 0;
    const c = new Coalescer(200, () => flushes++, 1000);
    for (let t = 0; t < 1200; t += 100) {
      c.mark();
      vi.advanceTimersByTime(100); // never idle for a full window
    }
    expect(flushes).toBeGreaterThanOrEqual(1); // maxWait forced at least one flush mid-stream
  });

  it('stop() cancels a pending flush', () => {
    let flushes = 0;
    const c = new Coalescer(200, () => flushes++);
    c.mark();
    c.stop();
    vi.advanceTimersByTime(500);
    expect(flushes).toBe(0);
  });
});
