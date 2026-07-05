/**
 * term prewarm lifecycle — the background hot-list warm must be CANCELLED when the server closes
 * (a test/host that constructs then closes must not fire 8 metered pulls 2s later and bake
 * empty-series junk into the real day-cache). Review-gate v1.71.x P1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSmileServer } from '../../../src/server/smile-web.js';
import { setTermCacheDir } from '../../../src/analytics/term-data.js';

const DISK = path.join(os.tmpdir(), `prewarm-${process.pid}`);

function fakeClients() {
  return {
    timeseriesClient: { getRange: vi.fn(async () => ({ data: 'instrument_id,raw_symbol\n' })) },
    metadataClient: { getDatasetRange: vi.fn(async () => ({ end: '2026-07-05T14:00:00Z' })) },
  };
}

describe('term prewarm lifecycle', () => {
  beforeEach(() => {
    setTermCacheDir(DISK);
    process.env.TERM_PREWARM_ROOTS = 'GC'; // one root, keeps the test tight
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.TERM_PREWARM_ROOTS;
    await fs.rm(DISK, { recursive: true, force: true });
  });

  it('a server closed before the 2s kick does NOT prewarm (setTimeout cleared on close)', async () => {
    const c = fakeClients();
    const server = createSmileServer(c, { prewarmTerm: true });
    server.emit('close'); // fires the close handler -> clearTimeout(prewarmKick)
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.metadataClient.getDatasetRange).not.toHaveBeenCalled();
    expect(c.timeseriesClient.getRange).not.toHaveBeenCalled();
  });

  // (the POSITIVE path — prewarm actually warming a root — is covered deterministically by
  // term-data.test's 'prewarmTerm warms each hot root'; here we only pin the lifecycle wiring.)

  it('prewarmTerm off -> never schedules a kick', async () => {
    const c = fakeClients();
    createSmileServer(c, {}); // no prewarmTerm
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.metadataClient.getDatasetRange).not.toHaveBeenCalled();
  });
});
