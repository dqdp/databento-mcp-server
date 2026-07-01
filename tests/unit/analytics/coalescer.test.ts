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

  it('maxWait forces a flush MID-stream (bounds latency, not just at the end)', () => {
    const start = Date.now();
    const fireAt: number[] = [];
    const c = new Coalescer(200, () => fireAt.push(Date.now() - start), 1000);
    for (let t = 0; t < 1200; t += 100) {
      c.mark();
      vi.advanceTimersByTime(100); // never idle for a full 200ms window
    }
    expect(fireAt.length).toBeGreaterThanOrEqual(1);
    expect(fireAt[0]).toBeLessThanOrEqual(1000); // fired at/under maxWait…
    expect(fireAt[0]).toBeLessThan(1200); // …strictly before the stream ended (would starve without maxWait)
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
