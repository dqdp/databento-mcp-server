/**
 * live-chain-consumer — the persistent Live session for a whole option-chain subscription.
 * Reuses the proven transport/CRAM/control helpers from live-client.ts, but instead of
 * resolving on the first quote it subscribes to a set of instrument_ids and streams the raw
 * post-handshake DBN bytes out via onData (fed to a LiveSmileFeed). Driven by a fake socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { computeDatabentoCramResponse } from '../../../src/api/live-client.js';
import { LiveChainConsumer, type LiveChainConsumerOptions } from '../../../src/api/live-chain-consumer.js';

class FakeSocket extends EventEmitter {
  written: string[] = [];
  ended = false;
  destroyed = false;
  write(d: string | Uint8Array): boolean {
    this.written.push(typeof d === 'string' ? d : Buffer.from(d).toString());
    return true;
  }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
  wrote(): string { return this.written.join(''); }
}

const KEY = 'db-testkey12345';

function make(opts: Partial<LiveChainConsumerOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  let opened = 0;
  const c = new LiveChainConsumer({
    apiKey: KEY,
    dataset: 'GLBX.MDP3',
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onData: (b) => chunks.push(b),
    onOpen: () => { opened++; },
    onError: (e) => errors.push(e.message),
    ...opts,
  });
  return { c, sockets, chunks, errors, opened: () => opened };
}

describe('LiveChainConsumer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does CRAM, subscribes to the instrument_ids, then pipes DBN bytes to onData', () => {
    const h = make();
    h.c.start([201, 202, 100]);
    const s = h.sockets[0];

    s.emit('data', Buffer.from('cram=ABC123\n'));
    expect(s.wrote()).toContain(computeDatabentoCramResponse('ABC123', KEY)); // authed

    s.emit('data', Buffer.from('success=1|session_id=xyz\n'));
    expect(s.wrote()).toMatch(/schema=mbp-1/);
    expect(s.wrote()).toMatch(/stype_in=instrument_id/);
    expect(s.wrote()).toMatch(/symbols=201,202,100/);
    expect(s.wrote()).toMatch(/start_session=0/);
    expect(h.opened()).toBe(1);

    s.emit('data', Buffer.from([9, 8, 7])); // now streaming DBN
    expect(h.chunks.some((b) => b.equals(Buffer.from([9, 8, 7])))).toBe(true);
  });

  it('surfaces an auth failure via onError', () => {
    const h = make();
    h.c.start([201]);
    h.sockets[0].emit('data', Buffer.from('cram=ABC\n'));
    h.sockets[0].emit('data', Buffer.from('success=0|error=bad key\n'));
    expect(h.errors.some((m) => /bad key|auth/i.test(m))).toBe(true);
  });

  it('rejects a subscription above the 2000-symbol cap', () => {
    const h = make();
    expect(() => h.c.start(Array.from({ length: 2001 }, (_, i) => i + 1))).toThrow(/2000/);
  });

  it('auto-reconnects on socket close when enabled', () => {
    const h = make({ reconnect: true });
    h.c.start([201]);
    expect(h.sockets).toHaveLength(1);
    h.sockets[0].emit('close');
    vi.advanceTimersByTime(1100);
    expect(h.sockets).toHaveLength(2); // reconnected
  });

  it('stop() ends the socket and prevents reconnect', () => {
    const h = make({ reconnect: true });
    h.c.start([201]);
    h.c.stop();
    expect(h.sockets[0].ended).toBe(true);
    h.sockets[0].emit('close');
    vi.advanceTimersByTime(2000);
    expect(h.sockets).toHaveLength(1); // no reconnect after stop
  });

  it('a delayed event from a replaced socket does not churn the healthy reconnected one', () => {
    // P1: reconnect must not let a stale error+close double-fire from the DEAD socket tear down
    // the healthy socket that already replaced it.
    const h = make({ reconnect: true });
    h.c.start([201]);
    h.sockets[0].emit('error', new Error('network blip')); // socket[0] dies -> schedule reconnect
    vi.advanceTimersByTime(1100);
    expect(h.sockets).toHaveLength(2); // socket[1] is healthy
    h.sockets[0].emit('close'); // OS-delayed close from the ALREADY-dead socket[0]
    vi.advanceTimersByTime(2000);
    expect(h.sockets).toHaveLength(2); // ignored: no socket[2], socket[1] untouched
  });

  it('does not reconnect after an auth failure (no hot-loop on bad credentials)', () => {
    // P1: success=0 is a permanent failure; the socket must be torn down and NOT retried even
    // with reconnect:true (the production wiring), else it hot-loops the same bad key forever.
    const h = make({ reconnect: true });
    h.c.start([201]);
    h.sockets[0].emit('data', Buffer.from('cram=ABC\n'));
    h.sockets[0].emit('data', Buffer.from('success=0|error=bad key\n'));
    expect(h.errors.some((m) => /bad key|auth/i.test(m))).toBe(true);
    expect(h.sockets[0].destroyed).toBe(true); // torn down, not left open
    h.sockets[0].emit('close'); // gateway drops the rejected socket
    vi.advanceTimersByTime(2000);
    expect(h.sockets).toHaveLength(1); // no reconnect with the same bad credentials
  });

  it('times out a hung handshake, surfaces an error, and reconnects', () => {
    // P2: a gateway that accepts TCP but never sends cram=/success= would otherwise hang
    // forever (no close/error), silently serving stale seed data. A handshake timeout recovers it.
    const h = make({ reconnect: true, handshakeTimeoutMs: 5000 });
    h.c.start([201]);
    vi.advanceTimersByTime(5000); // gateway sent nothing
    expect(h.errors.some((m) => /handshake|timed out/i.test(m))).toBe(true);
    expect(h.sockets[0].destroyed).toBe(true);
    vi.advanceTimersByTime(1100); // reconnect delay
    expect(h.sockets).toHaveLength(2);
  });

  it('does not fire the handshake timeout once streaming has started', () => {
    const h = make({ handshakeTimeoutMs: 5000 });
    h.c.start([201]);
    h.sockets[0].emit('data', Buffer.from('cram=ABC\n'));
    h.sockets[0].emit('data', Buffer.from('success=1\n')); // handshake complete -> streaming
    vi.advanceTimersByTime(10000);
    expect(h.errors).toHaveLength(0);
    expect(h.sockets[0].destroyed).toBe(false);
  });
});
