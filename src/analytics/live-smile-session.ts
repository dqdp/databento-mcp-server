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
  private lastBuildError: string | null = null;

  constructor(seed: SeedOpts, instrumentIds: number[], makeConsumer: ConsumerFactory, opts: { coalesceMs?: number } = {}) {
    this.feed = new LiveSmileFeed({
      ...seed,
      coalesceMs: opts.coalesceMs,
      onChain: (chain) => {
        this.latest = chain;
        this.lastError = null;
        this.lastBuildError = null;
      },
      onError: (err) => {
        this.lastError = err.message;
      },
      onBuildError: (err) => {
        this.lastBuildError = err.message;
      },
    });
    try {
      this.latest = this.feed.current(); // the seeded chain, before any live tick
    } catch (e) {
      // Seed not buildable YET: no forward, or every option book gated as a placeholder shell
      // (the HO 6am class — routine for hours pre-RTH). Keep the reason for buildError(); it
      // must NOT go into lastError — smile-web treats error() as gateway poison (evict + stop),
      // which would re-seed a metered session per poll all morning.
      this.latest = null;
      this.lastBuildError = (e as Error).message;
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

  /** Why current() is (still) null — the last seed/flush build failure (e.g. all books gated as
   * shells). Cleared on the first successful build. Distinct from error(): NOT session poison. */
  buildError(): string | null {
    return this.lastBuildError;
  }

  stop(): void {
    this.consumer.stop();
    this.feed.stop();
  }
}
