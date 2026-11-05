import { createHash } from 'node:crypto';
import { DumpInputError } from './dump-input.ts';
import { DEFAULT_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';
import type { VndbEntries } from './vndb-materialization.ts';

export type VndbTableSnapshot = {
  timestamp: string;
  asOf: string;
  /** Digest of ordered member identities and content digests, independent of chunking. */
  membersDigest: string;
};

/** Observe admitted members without retaining catalogue prose, images or private tables. */
export class VndbSnapshotReader {
  private timestamp: string | null = null;
  private readonly members = createHash('sha256');

  constructor(private readonly chunkBytes = DEFAULT_DUMP_CHUNK_BYTES) {}

  async *entries(entries: VndbEntries): VndbEntries {
    for await (const entry of entries) {
      const self = this;
      yield {
        ...entry,
        bytes: (async function* () {
          // VndbTablesStore admits the member before requesting its body.
          const content = createHash('sha256');
          const isTimestamp = entry.path === 'TIMESTAMP';
          if (isTimestamp && (self.timestamp !== null || entry.kind !== 'file' || entry.declaredBytes > 64))
            throw new DumpInputError();
          const timestamp = isTimestamp ? new Uint8Array(64) : null;
          let used = 0;
          for await (const chunk of entry.bytes) {
            // Check backing allocation before hashing or copying external bytes.
            if (!(chunk instanceof Uint8Array) || chunk.buffer.byteLength > self.chunkBytes) throw new DumpInputError();
            content.update(chunk);
            if (timestamp) {
              if (used + chunk.length > timestamp.length) throw new DumpInputError();
              timestamp.set(chunk, used);
              used += chunk.length;
            }
            yield chunk;
          }
          self.members.update(JSON.stringify([entry.path, entry.kind, entry.declaredBytes, content.digest('hex')]));
          if (timestamp) {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(timestamp.subarray(0, used));
            const value = text.endsWith('\n') ? text.slice(0, -1) : text;
            if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00$/.test(value)) throw new DumpInputError();
            const iso = value.slice(0, 10) + 'T' + value.slice(11, 19) + '.000Z';
            const date = new Date(iso);
            if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new DumpInputError();
            self.timestamp = value;
          }
        })(),
      };
    }
  }

  finish(): VndbTableSnapshot | null {
    return this.timestamp === null
      ? null
      : { timestamp: this.timestamp, asOf: this.timestamp.slice(0, 10), membersDigest: this.members.digest('hex') };
  }
}
