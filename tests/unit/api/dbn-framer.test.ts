/**
 * dbn-framer — split a DBN byte stream (metadata prelude + length-prefixed records) into record
 * buffers. Same framing the working Live client uses, but yields EVERY record (a persistent
 * chain consumer needs all of them, not just the first quote). Handles chunk boundaries.
 */
import { describe, it, expect } from 'vitest';
import { DbnFramer } from '../../../src/api/dbn-framer.js';

/** 8-byte prelude: "DBN" + version + u32 metadataLength, then `metaLen` metadata bytes. */
function prelude(metaLen = 0): Buffer {
  const b = Buffer.alloc(8 + metaLen);
  b.write('DBN', 0, 'ascii');
  b[3] = 2; // version
  b.writeUInt32LE(metaLen, 4);
  return b;
}
/** An 80-byte record whose header length byte (×4) = 80. */
function record(rtype: number, iid: number): Buffer {
  const b = Buffer.alloc(80);
  b[0] = 80 / 4; // length unit
  b[1] = rtype;
  b.writeUInt32LE(iid, 4);
  return b;
}

describe('DbnFramer', () => {
  it('skips the metadata prelude and yields each complete record', () => {
    const f = new DbnFramer();
    f.write(Buffer.concat([prelude(0), record(1, 201), record(1, 202)]));
    const recs = [...f.records()];
    expect(recs).toHaveLength(2);
    expect(recs[0].length).toBe(80);
    expect(recs[0].readUInt32LE(4)).toBe(201);
    expect(recs[1].readUInt32LE(4)).toBe(202);
  });

  it('reassembles records split across chunks', () => {
    const f = new DbnFramer();
    const stream = Buffer.concat([prelude(4), record(1, 300)]); // 4 metadata bytes
    f.write(stream.subarray(0, 10)); // mid-prelude
    expect([...f.records()]).toHaveLength(0); // not enough yet
    f.write(stream.subarray(10, 40));
    expect([...f.records()]).toHaveLength(0); // partial record
    f.write(stream.subarray(40));
    const recs = [...f.records()];
    expect(recs).toHaveLength(1);
    expect(recs[0].readUInt32LE(4)).toBe(300);
  });

  it('throws on a non-DBN stream', () => {
    const f = new DbnFramer();
    f.write(Buffer.from('XXXXXXXX'));
    expect(() => [...f.records()]).toThrow(/DBN/);
  });
});
