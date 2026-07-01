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
import { resolveOptionsRoot } from '../analytics/pull-chain.js';
import { fetchSmileSnapshot, type SmileClients } from '../analytics/smile-snapshot.js';
import { renderSmileHtml } from '../analytics/smile-html.js';

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

export function createSmileServer(clients: SmileClients): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = url.pathname.match(/^\/smile\/([^/]+?)(\.json)?$/);
        if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) {
          send(res, 404, 'application/json', JSON.stringify({ error: 'not_found' }));
          return;
        }
        const root = decodeURIComponent(m[1]);
        const isJson = Boolean(m[2]);
        const expiry = url.searchParams.get('expiry') ?? undefined;
        const windowStr = url.searchParams.get('window');
        const window = windowStr ? Number(windowStr) : undefined;
        const interval = Number(url.searchParams.get('interval') ?? '10') || 10;

        if (isJson) {
          try {
            const chain = await fetchSmileSnapshot(clients, root, { expiry, window });
            send(res, 200, 'application/json', JSON.stringify(chain));
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
}
