/**
 * fetchSmileSnapshot — the one place that turns "root (+ expiry/window)" into a Chain the way
 * the MCP tool does: resolve the selector, clamp `now` to the dataset's available_end, reuse
 * the daily-cached defs+OI, and buildSmile. Shared by the MCP tool handler, the live web
 * server, and the opt-in smoke so the clamp/cache wiring lives once.
 */
import type { Chain } from './chain.js';
import { buildSmile, clampNowToAvailable, resolveExpirySelector, type TimeseriesSource } from './pull-chain.js';
import { loadSmileStatic } from './smile-cache.js';

const DATASET = 'GLBX.MDP3';

export interface SmileClients {
  timeseriesClient: TimeseriesSource;
  metadataClient: { getDatasetRange(params: { dataset: string }): Promise<unknown> };
}

export async function fetchSmileSnapshot(
  clients: SmileClients,
  root: string,
  opts: { expiry?: string; window?: number; dataset?: string } = {},
): Promise<Chain> {
  const dataset = opts.dataset ?? DATASET;
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

  const { defs, oi } = await loadSmileStatic(clients.timeseriesClient, root, { asOf: today, end: nowIso, dataset });
  return buildSmile(clients.timeseriesClient, root, {
    today,
    now: nowIso,
    expiry,
    mode,
    window: opts.window,
    cachedDefs: defs,
    cachedOi: oi,
    dataset,
  });
}
