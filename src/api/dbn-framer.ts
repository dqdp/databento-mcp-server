/**
 * dbn-framer — split a raw DBN byte stream into record buffers. Mirrors the framing in the
 * working Live client (live-client.ts DbnMbp1QuoteDecoder) — skip the "DBN" metadata prelude
 * once, then peel length-prefixed records (record[0] * 4 bytes) — but yields EVERY record so a
 * persistent chain consumer can decode all of them (not just the first quote). Chunk-safe.
 */
const DBN_PREFIX = 'DBN';
const DBN_PRELUDE_LENGTH = 8;
const DBN_RECORD_HEADER_LENGTH = 16;
const DBN_RECORD_LENGTH_MULTIPLIER = 4;

export class DbnFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private metadataSkipped = false;

  write(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Yield each complete record currently buffered (call after each write). */
  *records(): Generator<Buffer> {
    if (!this.skipMetadata()) return;
    while (this.buffer.length >= DBN_RECORD_HEADER_LENGTH) {
      const recordLength = this.buffer[0] * DBN_RECORD_LENGTH_MULTIPLIER;
      if (recordLength < DBN_RECORD_HEADER_LENGTH) {
        throw new Error(`Invalid DBN record length: ${recordLength}`);
      }
      if (this.buffer.length < recordLength) return; // wait for the rest of this record
      yield this.buffer.subarray(0, recordLength);
      this.buffer = this.buffer.subarray(recordLength);
    }
  }

  private skipMetadata(): boolean {
    if (this.metadataSkipped) return true;
    if (this.buffer.length < DBN_PRELUDE_LENGTH) return false;
    if (this.buffer.toString('ascii', 0, 3) !== DBN_PREFIX) {
      throw new Error('Databento Live stream did not start with DBN metadata');
    }
    const total = DBN_PRELUDE_LENGTH + this.buffer.readUInt32LE(4);
    if (this.buffer.length < total) return false;
    this.buffer = this.buffer.subarray(total);
    this.metadataSkipped = true;
    return true;
  }
}
