/** Measurements of admitted bytes, line copies and simultaneously retained storage. */
export interface DumpCounters {
  pulledBytes: number;
  pulledChunks: number;
  scannedBytes: number;
  copiedBytes: number;
  peakBufferBytes: number;
  peakRetainedBytes: number;
  yieldedRecords: number;
}

export const MAX_DUMP_CHUNK_BYTES = 1048576;
export const DEFAULT_DUMP_CHUNK_BYTES = 262144;

export const DEFAULT_DUMP_RECORD_BYTES = 262144;
export const MAX_DUMP_RECORD_BYTES = 1048576;

export function dumpRecordLimit(value: number | undefined): number {
  const cap = value === undefined ? DEFAULT_DUMP_RECORD_BYTES : value;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > MAX_DUMP_RECORD_BYTES)
    throw new Error('Invalid dump record byte limit');
  return cap;
}

export function dumpChunkLimit(value: number | undefined): number {
  const cap = value === undefined ? DEFAULT_DUMP_CHUNK_BYTES : value;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > MAX_DUMP_CHUNK_BYTES)
    throw new Error('Invalid dump chunk byte limit');
  return cap;
}

export function createDumpCounters(): DumpCounters {
  return {
    pulledBytes: 0,
    pulledChunks: 0,
    scannedBytes: 0,
    copiedBytes: 0,
    peakBufferBytes: 0,
    peakRetainedBytes: 0,
    yieldedRecords: 0,
  };
}

export interface DumpRetention {
  input: number;
  line: number;
  scratch: number;
  metadata: number;
  total: number;
}
let observer: ((sample: DumpRetention) => void) | undefined;
/** Optional allocation instrumentation; never retains samples or source identities. */
export function observeDumpRetention(next: (sample: DumpRetention) => void): () => void {
  const previous = observer;
  observer = next;
  return () => {
    observer = previous;
  };
}

type Storage = Uint8Array | string | readonly string[] | ReadonlySet<string> | null;
type Region = 'input' | 'line' | 'scratch' | 'metadata';
/** Fixed slots describe live parser storage, including overlapping growth buffers.
 * String storage is charged as UTF-16 code units; buffer views charge the entire
 * backing, once by identity. Reference slots and numeric counters are charged as
 * eight-byte cells. This measures storage capacity, not engine object headers or
 * GC timing. Parsed output objects belong to the consumer, not this ledger.
 */
export class DumpMemory {
  private readonly slots: Storage[] = Array<Storage>(16).fill(null);
  private readonly regions: Region[] = Array<Region>(16).fill('scratch');
  private readonly sizes = new Float64Array(16);
  constructor(private readonly counters: DumpCounters) {
    this.sample();
  }
  hold(slot: number, storage: Storage, region: Region = 'scratch'): void {
    this.slots[slot] = storage;
    this.regions[slot] = region;
    let bytes = 0;
    if (typeof storage === 'string') bytes = storage.length * 2;
    else if (Array.isArray(storage) || storage instanceof Set) {
      bytes = (storage instanceof Set ? storage.size : storage.length) * 8;
      for (const value of storage) bytes += value.length * 2;
    } else if (storage instanceof Uint8Array) bytes = storage.buffer.byteLength;
    this.sizes[slot] = bytes;
    this.sample();
  }
  sample(): void {
    const sample: DumpRetention = {
      input: 0,
      line: 0,
      scratch: 0,
      metadata: (this.slots.length + this.regions.length + 7) * 8 + this.sizes.byteLength,
      total: 0,
    };
    for (let i = 0; i < this.slots.length; i++) {
      const storage = this.slots[i];
      if (storage == null) continue;
      let shared = false;
      if (storage instanceof Uint8Array) {
        for (let j = 0; j < i; j++) {
          const other = this.slots[j];
          if (other instanceof Uint8Array && other.buffer === storage.buffer) {
            shared = true;
            break;
          }
        }
      }
      if (!shared) sample[this.regions[i]!] += this.sizes[i]!;
    }
    sample.total = sample.input + sample.line + sample.scratch + sample.metadata;
    this.counters.peakRetainedBytes = Math.max(this.counters.peakRetainedBytes, sample.total);
    observer?.(sample);
  }
  close(): void {
    this.slots.fill(null);
    this.sample();
  }
}

/** Retain one bounded owned input backing and one geometrically grown line.
 * The fifth argument shares the allocation ledger with the native record parser.
 */
export async function* dumpLines(
  input: AsyncIterable<Uint8Array>,
  limit: () => number,
  counters: DumpCounters,
  options: { maxChunkBytes?: number } = {},
  memory?: DumpMemory,
): AsyncGenerator<Uint8Array> {
  const chunkCap = dumpChunkLimit(options.maxChunkBytes);
  const retained = memory ?? new DumpMemory(counters);
  let buffer = new Uint8Array(0);
  let length = 0;
  try {
    for await (const chunk of input) {
      counters.pulledChunks++;
      // Inspect allocation size before admission, scanning, copying or yielding.
      if (!(chunk instanceof Uint8Array) || chunk.buffer.byteLength > chunkCap)
        throw new Error('Dump chunk backing exceeds byte limit');
      counters.pulledBytes += chunk.byteLength;
      retained.hold(0, chunk, 'input');
      try {
        let start = 0;
        while (start < chunk.length) {
          const cap = limit();
          if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Invalid dump line byte limit');
          let end = start;
          const stop = Math.min(chunk.length, start + cap - length + 1);
          let newline = false;
          while (end < stop) {
            counters.scannedBytes++;
            if (chunk[end] === 10) {
              newline = true;
              break;
            }
            end++;
          }
          const needed = length + end - start;
          if (needed > cap) throw new Error('Dump line exceeds byte limit');
          if (buffer.length < needed) {
            const next = new Uint8Array(Math.min(cap, Math.max(needed, buffer.length * 2, 64)));
            retained.hold(2, next, 'line'); // Old and new allocations overlap during copying.
            next.set(buffer.subarray(0, length));
            counters.copiedBytes += length;
            buffer = next;
            retained.hold(1, buffer, 'line');
            retained.hold(2, null);
            counters.peakBufferBytes = Math.max(counters.peakBufferBytes, buffer.length);
          }
          buffer.set(chunk.subarray(start, end), length);
          counters.copiedBytes += end - start;
          length = needed;
          if (newline) {
            retained.sample();
            yield buffer.subarray(0, length - (buffer[length - 1] === 13 ? 1 : 0));
            length = 0;
            start = end + 1;
          } else start = end;
        }
      } finally {
        retained.hold(0, null);
      }
    }
    if (length) {
      retained.sample();
      yield buffer.subarray(0, length - (buffer[length - 1] === 13 ? 1 : 0));
    }
  } finally {
    retained.hold(1, null);
    retained.hold(2, null);
    if (!memory) retained.close();
  }
}
