/**
 * live-seed — build the LiveSmileFeed's starting state from the Historical pull, plus the
 * instrument_ids to subscribe the Live session to. Live has no snapshot-on-subscribe, so the
 * buffer is seeded from a Historical snapshot (defs + OI + an initial quote set) and then live
 * ticks update it. Scope: ONE expiration's ±window options + the future — never the whole parent.
 */
import type { SeedOpts } from './live-chain.js';
import {
  chooseExpiration,
  chooseMostLiquid,
  clampNowToAvailable,
  listExpirations,
  pullQuotesSnapshot,
  resolveExpirySelector,
  resolveOptionsRoot,
} from './pull-chain.js';
import { loadSmileStatic } from './smile-cache.js';
import type { SmileClients } from './smile-snapshot.js';

const DATASET = 'GLBX.MDP3';

export interface SeededLive {
  seed: SeedOpts;
  instrumentIds: number[];
}

export async function seedLiveFromHistorical(
  clients: SmileClients,
  root: string,
  opts: { expiry?: string; window?: number; dataset?: string } = {},
): Promise<SeededLive> {
  const dataset = opts.dataset ?? DATASET;
  const optRoot = resolveOptionsRoot(root);
  const { mode, expiry } = resolveExpirySelector(opts.expiry);

  let availableEnd: string | undefined;
  try {
    const range = (await clients.metadataClient.getDatasetRange({ dataset })) as { end?: string; end_date?: string };
    availableEnd = range?.end ?? range?.end_date;
  } catch {
    availableEnd = undefined;
  }
  const nowIso = clampNowToAvailable(new Date().toISOString(), availableEnd);
  const today = nowIso.slice(0, 10);

  const { defs, oi } = await loadSmileStatic(clients.timeseriesClient, optRoot, { asOf: today, end: nowIso, dataset });
  const expiration =
    mode === 'most-liquid' ? chooseMostLiquid(defs, oi, { today }) : chooseExpiration(defs, { expiry, today, mode });

  const window = opts.window ?? 20;
  const pullWindow = Math.max(window, 20) + 40; // same band as buildSmile (25-delta stays inside)
  const snap = await pullQuotesSnapshot(clients.timeseriesClient, defs, expiration, { now: nowIso, pullWindow, dataset });

  const expDefs = defs.filter(
    (d) => (d.instrument_class === 'C' || d.instrument_class === 'P') && d.expiration === expiration,
  );
  const dte = Math.round((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

  const seed: SeedOpts = {
    symbol: optRoot,
    expiration,
    T: Math.max(1, dte) / 365,
    window,
    allExpirations: listExpirations(defs),
    futureDef: snap.futureDef,
    expDefs, // whole expiration (OI aggregates); live quotes cover the narrowed subset
    oi,
    quotes: snap.quotes,
  };
  const instrumentIds = [...snap.expirationDefs.map((d) => d.instrument_id), snap.futureDef.instrument_id];
  return { seed, instrumentIds };
}
