/**
 * coalescer — debounce live ticks into flushes. Each `mark()` (a changed strike) schedules a
 * trailing flush `windowMs` later; a burst of marks collapses into ONE flush. `maxWaitMs`
 * bounds latency so a never-idle stream still flushes periodically instead of starving. This is
 * a RENDER throttle (rebuild + diff to the page), not a data poll — the union of changed
 * instruments lives on the live buffer, so the flush callback just reads it.
 */
export type FlushFn = () => void;

export class Coalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstMarkAt = 0;

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: FlushFn,
    private readonly maxWaitMs = 1000,
  ) {}

  mark(): void {
    const now = Date.now();
    if (this.timer == null) this.firstMarkAt = now;
    else clearTimeout(this.timer);
    const sinceFirst = now - this.firstMarkAt;
    const wait = Math.max(0, Math.min(this.windowMs, this.maxWaitMs - sinceFirst));
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private fire(): void {
    this.timer = null;
    this.firstMarkAt = 0;
    this.onFlush();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
