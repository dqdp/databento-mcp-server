/**
 * live-feed — the offline heart of the Live smile consumer. Raw DBN bytes (from the socket) ->
 * frame records -> decode L1 quotes -> fold into the live buffer -> coalesce -> emit ONE rebuilt
 * Chain per flush. Pure w.r.t. the network: the socket only calls onData(chunk); everything here
 * is unit-tested with synthetic bytes. The socket wiring (connect/CRAM/subscribe/lifecycle) lives
 * in the consumer that feeds onData.
 */
import { DbnFramer } from '../api/dbn-framer.js';
import { decodeL1Quote } from '../api/dbn-quote.js';
import type { Chain } from './chain.js';
import { Coalescer } from './coalescer.js';
import { buildLiveChain, onLiveQuote, seedLiveChain, type LiveChain, type SeedOpts } from './live-chain.js';

const DBN_RTYPE_MBP_1 = 1;
const DBN_RTYPE_ERROR = 21;
const DBN_RECORD_HEADER_LENGTH = 16;
// L1 quote record types we fold (mbp-1 now; bbo-1s/bbo-1m rtypes share the body layout and can
// be added here once confirmed on the live feed).
const L1_RTYPES = new Set<number>([DBN_RTYPE_MBP_1]);

export interface LiveFeedOpts extends SeedOpts {
  coalesceMs?: number;
  onChain: (chain: Chain) => void;
  /** Surfaced for gateway ERROR records (bad symbol, auth/entitlement, rejected subscription). */
  onError?: (err: Error) => void;
}

export class LiveSmileFeed {
  private readonly framer = new DbnFramer();
  private readonly lc: LiveChain;
  private readonly coalescer: Coalescer;
  private readonly onChain: (chain: Chain) => void;
  private readonly onError?: (err: Error) => void;

  constructor(opts: LiveFeedOpts) {
    this.lc = seedLiveChain(opts);
    this.onChain = opts.onChain;
    this.onError = opts.onError;
    // Guard the flush: buildChain throws until a forward + option quote exist (Live has no
    // snapshot-on-subscribe), and an uncaught throw inside the coalescer's setTimeout would
    // kill the feed. Skip un-buildable flushes silently; the next tick retries.
    this.coalescer = new Coalescer(opts.coalesceMs ?? 250, () => {
      let chain: Chain;
      try {
        chain = buildLiveChain(this.lc);
      } catch {
        return; // buffer not buildable yet (no forward / no quotes) — transient
      }
      this.onChain(chain);
    });
  }

  /** Feed a raw DBN chunk from the socket. Folds any complete L1 quotes and schedules a flush. */
  onData(chunk: Buffer): void {
    this.framer.write(chunk);
    for (const rec of this.framer.records()) {
      if (rec[1] === DBN_RTYPE_ERROR) {
        const msg = rec.toString('ascii', DBN_RECORD_HEADER_LENGTH).replace(/\0.*$/s, '').trim();
        this.onError?.(new Error(`Databento Live gateway error: ${msg || 'unknown error'}`));
        continue;
      }
      if (!L1_RTYPES.has(rec[1])) continue;
      const quote = decodeL1Quote(rec);
      if (quote) {
        onLiveQuote(this.lc, quote);
        this.coalescer.mark();
      }
    }
  }

  /** Rebuild immediately (e.g. the initial render right after seeding). */
  current(): Chain {
    return buildLiveChain(this.lc);
  }

  stop(): void {
    this.coalescer.stop();
  }
}
