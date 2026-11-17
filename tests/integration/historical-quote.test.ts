import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabentoMcpServer, createDefaultDatabentoMcpClients } from '../../mcp/index.js';
import { historicalQuoteProvider, quoteAvailability, quoteCsv, quoteNanos, QUOTE_END, QUOTE_NOW } from '../fixtures/historical-quotes.js';

// Exercise tools/call through the real server, client and HTTP serialization. Only fetch is fake.
describe('historical quote MCP contract', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(QUOTE_NOW));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connect(provider: ReturnType<typeof historicalQuoteProvider>) {
    const requests: Array<{ endpoint: string; params: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.origin).toBe('https://hist.databento.com');
      const params = Object.fromEntries(url.searchParams);
      requests.push({ endpoint: url.pathname, params });
      try { return new Response(await provider(url.pathname, params)); }
      catch (error) { return new Response(String(error), { status: 422 }); }
    }));
    const server = createDatabentoMcpServer(createDefaultDatabentoMcpClients('db-test-key'));
    const client = new Client({ name: 'quote-regression', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    return { client, server, requests };
  }

  it('returns the newest historical quote, frontier and advancing age through tools/call', async () => {
    const frontier = quoteNanos(QUOTE_END);
    const rows = Array.from({ length: 3000 }, (_, i) => ({ recv: frontier - 60_000_000_000n + BigInt(i) * 20_000_000n }));
    const { client, server, requests } = await connect(historicalQuoteProvider(rows));
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toContain('get_futures_quote');
      const result = await client.callTool({ name: 'get_futures_quote', arguments: { symbol: 'ES' } });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any)[0].text);
      expect(payload).toMatchObject({ symbol: 'ES', price: 7611.125, bid: 7611, ask: 7611.25, dataMode: 'historical', availableEnd: QUOTE_END });
      expect(payload.timestamp).toBe(new Date(Number((rows.at(-1)!.recv - 1000n) / 1_000_000n)).toISOString());
      const count = requests.length;
      vi.setSystemTime(Date.now() + 20_000);
      const cached = await client.callTool({ name: 'get_futures_quote', arguments: { symbol: 'ES' } });
      const cachedPayload = JSON.parse((cached.content as any)[0].text);
      expect(parseInt(cachedPayload.dataAge)).toBe(parseInt(payload.dataAge) + 20);
      expect(requests).toHaveLength(count);
      for (const r of requests.filter(r => r.endpoint === '/v0/timeseries.get_range')) {
        expect(quoteNanos(r.params.end)).toBeLessThanOrEqual(frontier);
        expect(r.params.encoding).toBe('csv');
      }
    } finally { await client.close(); await server.close(); }
  });

  it('returns an MCP tool error when a bounded search cannot establish the latest record', async () => {
    const { client, server, requests } = await connect(async (endpoint, params) => endpoint.includes('metadata')
      ? JSON.stringify(quoteAvailability())
      : quoteCsv(Array.from({ length: Number(params.limit) }, () => ({ recv: quoteNanos(params.start) }))));
    try {
      const result = await client.callTool({ name: 'get_futures_quote', arguments: { symbol: 'NQ' } });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('Unable to establish the latest historical quote');
      expect(requests.length).toBeLessThanOrEqual(33);
    } finally { await client.close(); await server.close(); }
  });
});
