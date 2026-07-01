/**
 * live-smile-session — one live dashboard's state: the Historical seed + a LiveSmileFeed + a Live
 * consumer, wired so consumer bytes flow into the feed and current() exposes the latest built
 * chain. Seeded immediately (Live has no snapshot-on-subscribe), then live ticks update it. The
 * consumer is injected (a factory taking the feed's onData) so this is transport-agnostic and
 * offline-testable; smile-web owns the map of sessions keyed by (root, expiration).
 */
import type { Chain } from './chain.js';
import type { SeedOpts } from './live-chain.js';
import { LiveSmileFeed } from './live-feed.js';

export interface LiveConsumer {
  start(instrumentIds: number[]): void;
  stop(): void;
}
export type ConsumerFactory = (onData: (chunk: Buffer) => void) => LiveConsumer;

export class LiveSmileSession {
  private readonly feed: LiveSmileFeed;
  private readonly consumer: LiveConsumer;
  private latest: Chain | null = null;
  private lastError: string | null = null;

  constructor(seed: SeedOpts, instrumentIds: number[], makeConsumer: ConsumerFactory, opts: { coalesceMs?: number } = {}) {
    this.feed = new LiveSmileFeed({
      ...seed,
      coalesceMs: opts.coalesceMs,
      onChain: (chain) => {
        this.latest = chain;
        this.lastError = null;
      },
      onError: (err) => {
        this.lastError = err.message;
      },
    });
    try {
      this.latest = this.feed.current(); // the seeded chain, before any live tick
    } catch {
      this.latest = null; // seed not buildable yet (no forward)
    }
    this.consumer = makeConsumer((chunk) => this.feed.onData(chunk));
    this.consumer.start(instrumentIds);
  }

  /** The latest built chain (seeded, then updated by live ticks), or null until buildable. */
  current(): Chain | null {
    return this.latest;
  }

  /** The last gateway error surfaced by the consumer, if any. */
  error(): string | null {
    return this.lastError;
  }

  stop(): void {
    this.consumer.stop();
    this.feed.stop();
  }
}
