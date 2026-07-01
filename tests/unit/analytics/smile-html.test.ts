/**
 * smile-html — renders a Chain into a standalone Chart.js dashboard page (the local/preview
 * analogue of the Chart.js artifact the MCP tool asks the model to render). Must embed the
 * chain safely (no </script> breakout) and carry the real numbers.
 */
import { describe, it, expect } from 'vitest';
import type { Chain } from '../../../src/analytics/chain.js';
import { renderSmileHtml } from '../../../src/analytics/smile-html.js';

const chain: Chain = {
  symbol: 'LO', expiration: '2026-11-17', dte: 139, asOf: '2026-07-01T10:00:00.000Z',
  spot: 68.04, spotEstimated: false, atmStrike: 68, atmIV: 0.356, skew25: -0.015,
  call25IV: 0.38, put25IV: 0.365, call25Strike: 81.5, put25Strike: 59.5,
  pcrOI: 1.39, pcrVol: null, callOItotal: 159913, putOItotal: 229799, maxPain: 70,
  nContracts: 202, nExpirations: 78, expirations: ['2026-11-17', '2026-12-16'], window: 20,
  strikes: [66, 67, 68, 69, 70], callIV: [0.37, 0.362, 0.356, 0.357, 0.359], putIV: [0.372, 0.365, 0.356, 0.356, 0.357],
  callOI: [100, 200, 8252, 300, 400], putOI: [500, 600, 700, 800, 900],
  callDelta: [0.6, 0.55, 0.5, 0.45, 0.4], putDelta: [-0.4, -0.45, -0.5, -0.55, -0.6],
  callVol: [null, null, null, null, null], putVol: [null, null, null, null, null],
};

describe('renderSmileHtml', () => {
  const html = renderSmileHtml(chain);

  it('is a full HTML document loading Chart.js from the allowed CDN', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('cdnjs.cloudflare.com/ajax/libs/Chart.js');
    expect(html).toContain('</html>');
  });

  it('carries the chain numbers and title', () => {
    expect(html).toContain('LO'); // symbol
    expect(html).toContain('2026-11-17'); // expiration
    expect(html).toContain('68.04'); // forward
    expect(html).toContain('"atmStrike":68'); // embedded data
  });

  it('escapes < so an embedded value cannot break out of the script tag', () => {
    const evil = { ...chain, symbol: '</script><script>alert(1)</script>' };
    const out = renderSmileHtml(evil);
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script>'); // the < was escaped
  });
});

describe('renderSmileHtml — live (polling) mode', () => {
  const live = renderSmileHtml(chain, { live: { jsonUrl: '/smile/LO.json', interval: 10 } });

  it('embeds the poll URL and a poll loop', () => {
    expect(live).toContain('/smile/LO.json');
    expect(live).toMatch(/fetch\(/);
  });

  it('renders a UI interval selector defaulting to the requested interval', () => {
    expect(live).toMatch(/<select[^>]*id="iv"/);
    expect(live).toMatch(/<option[^>]*value="10"[^>]*selected/);
    expect(live).toMatch(/value="5"/);
    expect(live).toMatch(/value="30"/);
    expect(live).toMatch(/value="60"/);
  });

  it('shows a LIVE badge (not the static snapshot chip)', () => {
    expect(live).toMatch(/LIVE/);
    expect(live).not.toContain('snapshot · as of'); // live mode replaces the snapshot chip
  });

  it('the static (no-opts) render stays a snapshot with no poll loop', () => {
    const staticHtml = renderSmileHtml(chain);
    expect(staticHtml).toContain('snapshot · as of');
    expect(staticHtml).not.toContain('id="iv"');
    expect(staticHtml).not.toMatch(/setInterval\(/);
  });
});
