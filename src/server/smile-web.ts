/**
 * smile-web — a small standalone HTTP server for the LEVEL-2 live smile (polled snapshot +
 * per-point update). It is the futures analogue of the equity `options.py --watch` page: NOT
 * the hardened MCP transport, just a local dev server that reuses this repo's snapshot analytics.
 *   GET /smile/:root         -> the live page (renderSmileHtml with a poll loop)
 *   GET /smile/:root.json    -> a fresh snapshot Chain as JSON (what the page polls)
 * Both accept ?expiry= & ?window=; the page also takes ?interval= (default 10s).
 */
import http from 'node:http';
import type { Chain } from '../analytics/chain.js';
import { seedLiveFromHistorical } from '../analytics/live-seed.js';
import { LiveSmileSession, type ConsumerFactory } from '../analytics/live-smile-session.js';
import { resolveExpirySelector, resolveOptionsRoot } from '../analytics/pull-chain.js';
import { fetchSmileSnapshot, type SmileClients } from '../analytics/smile-snapshot.js';
import { getTermData, isTermCached } from '../analytics/term-data.js';
import { clampNowToAvailable } from '../analytics/pull-chain.js';
import { renderSmileHtml } from '../analytics/smile-html.js';

export interface SmileServerOptions {
  /** Serve the .json from a persistent Live-socket buffer instead of a polled Historical pull. */
  live?: { makeConsumer: ConsumerFactory; coalesceMs?: number; idleMs?: number };
}

/** Cap the number of concurrent Live sessions (each holds an authenticated socket); LRU-evicted. */
export const MAX_LIVE_SESSIONS = 32;

/** An empty chain so the live page renders INSTANTLY; the first client poll fills it. */
function placeholder(root: string): Chain {
  return {
    symbol: resolveOptionsRoot(root.toUpperCase()), expiration: '…', dte: 0, asOf: null, spot: 0,
    spotEstimated: false, atmStrike: 0, atmIV: null, skew25: null, call25IV: null, put25IV: null,
    call25Strike: null, put25Strike: null, pcrOI: null, pcrVol: null, callOItotal: 0, putOItotal: 0,
    maxPain: 0, nContracts: 0, nExpirations: 0, expirations: [], window: 0, strikes: [], callIV: [],
    putIV: [], callOI: [], putOI: [], callDelta: [], putDelta: [], callVol: [], putVol: [],
  };
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function createSmileServer(clients: SmileClients, options: SmileServerOptions = {}): http.Server {
  // In live mode: one persistent Live session per (root, expiry, window), reused across polls. The
  // map holds the in-flight CONSTRUCTION promise (not the resolved session) so two concurrent cold
  // polls for the same key dedup onto one session — each session opens an authenticated Live
  // socket, and a lost race would orphan one forever (never stop()'d, even on server.close).
  const sessions = new Map<string, Promise<LiveSmileSession>>();
  // Last poll time per key. A live session holds a METERED Databento socket, so when nobody polls it
  // any more (the dashboard/browser closed), we must stop it — not leave it streaming in the
  // background. A sweeper stops sessions idle beyond IDLE_MS; the next poll re-seeds a fresh one.
  const lastPoll = new Map<string, number>();
  const IDLE_MS = Math.max(15_000, options.live?.idleMs ?? 45_000);

  function sessionKey(root: string, expiry: string | undefined, window: number | undefined): string {
    // Normalize the expiry selector so equivalent requests (nearest / NEAREST / absent all mean
    // "nearest") collapse onto ONE session instead of each opening its own socket. An explicit
    // date and `most-liquid` pass through as-is.
    const sel = resolveExpirySelector(expiry);
    const normExpiry = sel.expiry ?? sel.mode ?? 'nearest';
    return `${resolveOptionsRoot(root.toUpperCase())}|${normExpiry}|${window ?? ''}`;
  }

  async function liveCurrent(root: string, expiry: string | undefined, window: number | undefined): Promise<Chain | null> {
    const key = sessionKey(root, expiry, window);
    lastPoll.set(key, Date.now());   // mark demand; the idle sweeper stops sessions nobody polls
    let building = sessions.get(key);
    if (building) {
      sessions.delete(key); // LRU touch: mark most-recently-polled (Map preserves insertion order)
      sessions.set(key, building);
    } else {
      building = (async () => {
        const { seed, instrumentIds } = await seedLiveFromHistorical(clients, root, { expiry, window });
        return new LiveSmileSession(seed, instrumentIds, options.live!.makeConsumer, { coalesceMs: options.live!.coalesceMs });
      })();
      sessions.set(key, building);
      building.catch(() => { if (sessions.get(key) === building) sessions.delete(key); }); // don't cache a failed seed
      // Evict the least-recently-polled sessions beyond the cap, stopping their sockets.
      while (sessions.size > MAX_LIVE_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === key) break;
        const victim = sessions.get(oldest)!;
        sessions.delete(oldest);
        lastPoll.delete(oldest); // keep lastPoll from outliving its session (else it lingers until the next sweep)
        void victim.then((s) => s.stop()).catch(() => {});
      }
    }
    const session = await building;
    const err = session.error();
    if (err) {
      // A gateway ERROR (rejected subscription / entitlement) sets session.error(); it only clears
      // on a later successful flush, but a rejected subscription never produces one, so it would
      // wedge this key into a forever-503 with its socket held. Evict FIRST (delete before stop, so
      // a throwing stop can't leave the poisoned promise cached) so the next poll re-seeds.
      if (sessions.get(key) === building) {
        sessions.delete(key);
        lastPoll.delete(key); // evicting the session -> drop its lastPoll too, so it can't linger
      }
      session.stop();
      throw new Error(err);
    }
    return session.current();
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const tm = url.pathname.match(/^\/term\/([^/]+?)\.json$/);
        if (tm && (req.method === 'GET' || req.method === 'HEAD')) {
          // Cross-expiration payload for the skill's --term: day-cached (first pull of the day is
          // the slow Databento side; every later poll is instant). Keyless + loopback like /smile.
          try {
            const troot = decodeURIComponent(tm[1]);
            const maxSeries = Math.min(24, Math.max(1, Math.floor(Number(url.searchParams.get('maxSeries'))) || 10));
            const maxDays = Math.min(800, Math.max(30, Math.floor(Number(url.searchParams.get('maxDays'))) || 400));
            let availableEnd: string | undefined;
            try {
              const range = (await clients.metadataClient.getDatasetRange({ dataset: 'GLBX.MDP3' })) as {
                end?: string;
                end_date?: string;
              };
              availableEnd = range?.end ?? range?.end_date;
            } catch {
              availableEnd = undefined;
            }
            const nowIso = clampNowToAvailable(new Date().toISOString(), availableEnd);
            const asOf = nowIso.slice(0, 10);
            // ?probe=1 -> instant cache-status ONLY (pulls nothing) so the skill can warn
            // "in cache, no wait" vs "cold — first pull of the day, minutes" BEFORE committing.
            if (url.searchParams.get('probe')) {
              send(res, 200, 'application/json',
                JSON.stringify({ root: troot.toUpperCase(), asOf, cached: isTermCached(troot, { asOf, maxSeries, maxDays }) }));
              return;
            }
            const data = await getTermData(clients.timeseriesClient, troot, {
              asOf,
              end: nowIso,
              maxSeries,
              maxDays,
            });
            send(res, 200, 'application/json', JSON.stringify(data));
          } catch (e) {
            send(res, 503, 'application/json', JSON.stringify({ error: (e as Error).message }));
          }
          return;
        }
        const m = url.pathname.match(/^\/smile\/([^/]+?)(\.json)?$/);
        if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) {
          send(res, 404, 'application/json', JSON.stringify({ error: 'not_found' }));
          return;
        }
        const root = decodeURIComponent(m[1]);
        const isJson = Boolean(m[2]);
        const expiry = url.searchParams.get('expiry') ?? undefined;
        const windowStr = url.searchParams.get('window');
        // Clamp untrusted query params so a crafted request can't force a giant pull/render:
        // window matches the MCP tool's 1..200 bound; interval to a sane 2..300s.
        const window = windowStr ? Math.min(200, Math.max(1, Math.floor(Number(windowStr)) || 20)) : undefined;
        const interval = Math.min(300, Math.max(2, Math.floor(Number(url.searchParams.get('interval'))) || 10));

        if (isJson) {
          try {
            const chain = options.live
              ? await liveCurrent(root, expiry, window)
              : await fetchSmileSnapshot(clients, root, { expiry, window });
            if (chain) send(res, 200, 'application/json', JSON.stringify(chain));
            else send(res, 503, 'application/json', JSON.stringify({ error: 'live buffer warming up' }));
          } catch (e) {
            send(res, 503, 'application/json', JSON.stringify({ error: (e as Error).message }));
          }
          return;
        }

        // the live page: return a placeholder shell INSTANTLY (a real buildSmile can take tens of
        // seconds for a big chain — too long for a page load), then let the client's first poll
        // of the .json fill it in.
        const qs = new URLSearchParams();
        if (expiry) qs.set('expiry', expiry);
        if (windowStr) qs.set('window', windowStr);
        const jsonUrl = `/smile/${encodeURIComponent(root)}.json${qs.toString() ? `?${qs.toString()}` : ''}`;
        send(res, 200, 'text/html; charset=utf-8', renderSmileHtml(placeholder(root), { live: { jsonUrl, interval } }));
      } catch {
        send(res, 500, 'application/json', JSON.stringify({ error: 'internal_error' }));
      }
    })();
  });

  // Idle sweeper: stop the metered socket of any live session nobody has polled for IDLE_MS. This is
  // what makes "close the dashboard -> the background data load stops" true (the client stops polling
  // -> the session goes idle -> its socket is torn down). The next poll re-seeds a fresh session.
  const sweeper = options.live
    ? setInterval(() => {
        const now = Date.now();
        for (const [key, when] of lastPoll) {
          if (now - when <= IDLE_MS) continue;
          lastPoll.delete(key);
          const victim = sessions.get(key);
          if (victim) {
            sessions.delete(key);
            console.error(`[smile] idle-stop ${key} (no poll for ${Math.round((now - when) / 1000)}s) — closing Live socket`);
            void victim.then((s) => s.stop()).catch(() => {});
          }
        }
      }, Math.min(15_000, IDLE_MS))
    : null;
  if (sweeper && typeof sweeper.unref === 'function') sweeper.unref();

  // Tear down all Live sessions (and their sockets) when the server stops.
  server.on('close', () => {
    if (sweeper) clearInterval(sweeper);
    for (const p of sessions.values()) void p.then((s) => s.stop()).catch(() => {});
    sessions.clear();
    lastPoll.clear();
  });
  return server;
}
