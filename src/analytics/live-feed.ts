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
// L1 quote record types we fold (mbp-1 now; bbo-1s/bbo-1m rtypes share the body layout and can
// be added here once confirmed on the live feed).
const L1_RTYPES = new Set<number>([DBN_RTYPE_MBP_1]);

export interface LiveFeedOpts extends SeedOpts {
  coalesceMs?: number;
  onChain: (chain: Chain) => void;
}

export class LiveSmileFeed {
  private readonly framer = new DbnFramer();
  private readonly lc: LiveChain;
  private readonly coalescer: Coalescer;
  private readonly onChain: (chain: Chain) => void;

  constructor(opts: LiveFeedOpts) {
    this.lc = seedLiveChain(opts);
    this.onChain = opts.onChain;
    this.coalescer = new Coalescer(opts.coalesceMs ?? 250, () => this.onChain(buildLiveChain(this.lc)));
  }

  /** Feed a raw DBN chunk from the socket. Folds any complete L1 quotes and schedules a flush. */
  onData(chunk: Buffer): void {
    this.framer.write(chunk);
    for (const rec of this.framer.records()) {
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
