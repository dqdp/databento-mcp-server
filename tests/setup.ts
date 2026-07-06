/**
 * Global test setup — isolate ALL persistent caches to a per-worker temp dir so no test ever
 * writes into the real ~/.cache/databento-mcp (the review-gate lesson: a background/persistent
 * cache must never pollute the user's real day-cache from a test run).
 */
import * as os from 'node:os';
import * as path from 'node:path';

const base = path.join(os.tmpdir(), `dbn-mcp-test-${process.pid}`);
process.env.DEFS_CACHE_DIR = process.env.DEFS_CACHE_DIR || path.join(base, 'defs');
process.env.TERM_CACHE_DIR = process.env.TERM_CACHE_DIR || path.join(base, 'term');
process.env.TERM_PREWARM_ROOTS = process.env.TERM_PREWARM_ROOTS ?? ''; // no background prewarm in tests
