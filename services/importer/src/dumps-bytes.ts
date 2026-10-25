/** Optional per-iterator measurements of actual parser work, excluding key metadata. */
export interface DumpCounters {
  pulledBytes: number;
  pulledChunks: number;
  scannedBytes: number;
  copiedBytes: number;
  peakBufferBytes: number;
  peakRetainedBytes: number;
  yieldedRecords: number;
}

export function createDumpCounters(): DumpCounters {
  return { pulledBytes: 0, pulledChunks: 0, scannedBytes: 0, copiedBytes: 0,
    peakBufferBytes: 0, peakRetainedBytes: 0, yieldedRecords: 0 };
}

/** Retain one supplied chunk and a bounded line buffer, never concatenate chunks. */
export async function* dumpLines(input: AsyncIterable<Uint8Array>, limit: () => number,
  counters: DumpCounters): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);
  let length = 0;
  for await (const chunk of input) {
    counters.pulledChunks++;
    counters.pulledBytes += chunk.byteLength;
    let start = 0;
    while (start < chunk.length) {
      const cap = limit();
      // Search only as far as the bound; an enormous unterminated chunk must
      // neither be copied nor scanned in full before rejecting it.
      let end = start;
      const stop = Math.min(chunk.length, start + cap - length + 1);
      while (end < stop && chunk[end] !== 10) end++;
      counters.scannedBytes += end - start + (chunk[end] === 10 ? 1 : 0);
      const needed = length + end - start;
      if (needed > cap) throw new Error('Dump line exceeds byte limit');
      if (buffer.length < needed) {
        const capacity = Math.min(cap, Math.max(needed, buffer.length * 2, 64));
        const next = new Uint8Array(capacity);
        next.set(buffer.subarray(0, length));
        counters.copiedBytes += length;
        buffer = next;
      }
      buffer.set(chunk.subarray(start, end), length);
      counters.copiedBytes += end - start;
      length = needed;
      counters.peakBufferBytes = Math.max(counters.peakBufferBytes, buffer.length);
      counters.peakRetainedBytes = Math.max(counters.peakRetainedBytes, buffer.length + chunk.length);
      if (chunk[end] === 10) {
        yield buffer.subarray(0, length - (buffer[length - 1] === 13 ? 1 : 0));
        length = 0;
        start = end + 1;
      } else start = end;
    }
  }
  if (length) yield buffer.subarray(0, length - (buffer[length - 1] === 13 ? 1 : 0));
}
