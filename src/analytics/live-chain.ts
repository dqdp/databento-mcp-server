/**
 * live-chain — the in-memory chain buffer behind the LIVE smile. The socket consumer seeds the
 * static half ONCE from the Historical pull (definitions + open interest + an initial quote
 * snapshot — Live has no snapshot-on-subscribe, so illiquid strikes start from the Historical
 * mids), then folds each streamed quote tick in and rebuilds on a coalesced flush. `changed`
 * tracks the instrument_ids updated since the last flush so re-solve can be scoped later.
 *
 * It's a thin wrapper over the existing reducer (chain.ts): same applyTick/buildChain, warm-
 * started via the previous build. OI aggregates come from the WHOLE expiration's seeded OI
 * (not just streamed strikes), matching the snapshot tool.
 */
import {
  applyTick,
  buildChain,
  newState,
  type Chain,
  type ChainRec,
  type ChainState,
  type DefinitionRec,
  type QuoteRec,
} from './chain.js';

export interface LiveChain {
  state: ChainState;
  changed: Set<number>;
  symbol: string;
  expiration: string;
  T: number;
  window: number;
  allExpirations: string[];
  prev: Chain | null;
}

export interface SeedOpts {
  symbol: string;
  expiration: string;
  T: number;
  window?: number;
  allExpirations: string[];
  futureDef: DefinitionRec;
  expDefs: DefinitionRec[]; // the WHOLE expiration's C/P defs (OI aggregates span all of them)
  oi: Map<number, number>;
  quotes?: QuoteRec[]; // initial snapshot from the Historical pull (future + narrowed options)
}

/** Build a live buffer pre-loaded with the static defs/OI and an initial quote snapshot. */
export function seedLiveChain(opts: SeedOpts): LiveChain {
  const state = newState();
  const recs: ChainRec[] = [opts.futureDef, ...opts.expDefs];
  for (const d of opts.expDefs) {
    const v = opts.oi.get(d.instrument_id);
    if (v != null) recs.push({ type: 'statistics', instrument_id: d.instrument_id, stat_type: 'open_interest', value: v });
  }
  for (const rec of recs) applyTick(state, rec);
  for (const qr of opts.quotes ?? []) applyTick(state, qr);
  return {
    state,
    changed: new Set(),
    symbol: opts.symbol,
    expiration: opts.expiration,
    T: opts.T,
    window: opts.window ?? 20,
    allExpirations: opts.allExpirations,
    prev: null,
  };
}

/** Fold one streamed quote tick into the buffer and mark its instrument changed. */
export function onLiveQuote(lc: LiveChain, rec: QuoteRec): void {
  applyTick(lc.state, rec);
  lc.changed.add(rec.instrument_id);
}

/** Rebuild the chain from the buffer (warm-started from the previous build); resets `changed`. */
export function buildLiveChain(lc: LiveChain): Chain {
  const chain = buildChain(lc.symbol, lc.state, lc.expiration, lc.T, {
    window: lc.window,
    allExpirations: lc.allExpirations,
    prev: lc.prev,
  });
  lc.prev = chain;
  lc.changed.clear(); // "changed since the last flush" — reset so scoped re-solve stays bounded
  return chain;
}
