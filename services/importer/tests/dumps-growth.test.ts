import { expect, test } from 'bun:test';
import type { SourceId } from '@rezics/conversion';
import { readDump } from '../src/dumps';
import { createDumpCounters } from '../src/dumps-bytes';

const encoder = new TextEncoder();
const sources: SourceId[] = ['bangumi', 'vndb', 'openlibrary', 'wikidata'];
const scales = [32, 128, 512];
const cap = 512;
const chunkSize = 37;

// One deterministic seed, fixed-width identities and identical payload size at
// all three scales. Setup allocation is outside the measured parser operation.
function seed(source: SourceId, count: number, oversized = false) {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = 1000 + index;
    const title = 'x'.repeat(64);
    switch (source) {
      case 'bangumi': return JSON.stringify({ id, type: 2, name: title });
      case 'vndb': return `v${id}\t${title}\t\\N`;
      case 'openlibrary': return `/type/work\t/works/OL${id}W\t7\t2024-01-01\t${JSON.stringify({
        key: `/works/OL${id}W`, type: { key: '/type/work' }, revision: 7, title,
      })}`;
      case 'wikidata': return JSON.stringify({ id: `Q${id}`, type: 'item', lastrevid: 7, title });
    }
  });
  expect(new Set(rows.map(row => encoder.encode(row).length)).size).toBe(1);
  const header = source === 'vndb' ? 'COPY public.vn (id, description, image) FROM stdin;\n' : source === 'wikidata' ? '[\n' : '';
  const separator = source === 'wikidata' ? ',\n' : '\n';
  const footer = source === 'vndb' ? '\n\\.\n' : source === 'wikidata' ? '\n]\n' : '\n';
  const text = oversized ? `${header}${rows[0]}${separator}${'x'.repeat(count * cap)}` : `${header}${rows.join(separator)}${footer}`;
  return { bytes: encoder.encode(text), firstBytes: encoder.encode(`${header}${rows[0]}${separator}`).length };
}

function supplied(bytes: Uint8Array, size = chunkSize) {
  const observed = { chunks: 0, bytes: 0, closed: false };
  async function* input() {
    try {
      for (let offset = 0; offset < bytes.length; offset += size) {
        const part = bytes.subarray(offset, offset + size);
        observed.chunks++; observed.bytes += part.length;
        yield part;
      }
    } finally { observed.closed = true; }
  }
  return { input: input(), observed };
}

test('streaming parser growth follows supplied bytes with bounded per-record read-ahead', async () => {
  for (const source of sources) {
    for (const count of scales) {
      const { bytes, firstBytes } = seed(source, count);
      const full = supplied(bytes);
      const counters = createDumpCounters();
      let yielded = 0;
      for await (const _record of readDump(source, full.input, { maxRecordBytes: cap, counters })) {
        yielded++;
        if (yielded === 1) {
          expect(full.observed.bytes).toBeLessThan(bytes.length);
          expect(full.observed.bytes).toBeLessThanOrEqual(firstBytes + chunkSize);
        }
      }
      expect(yielded).toBe(count);
      expect(counters.yieldedRecords).toBe(count);
      expect(counters.pulledBytes).toBe(bytes.length);
      expect(counters.pulledChunks).toBe(Math.ceil(bytes.length / chunkSize));
      expect(counters.scannedBytes).toBe(bytes.length);
      // Geometric line-buffer growth copies less than two extra record lengths.
      expect(counters.copiedBytes).toBeLessThanOrEqual(3 * bytes.length);
      expect(counters.peakBufferBytes).toBeLessThanOrEqual(cap);
      expect(counters.peakRetainedBytes).toBeLessThanOrEqual(cap + chunkSize);
      expect(full.observed.closed).toBe(true);

      const early = supplied(bytes);
      const iterator = readDump(source, early.input, { maxRecordBytes: cap });
      expect((await iterator.next()).done).toBe(false);
      const pulled = early.observed.bytes;
      await iterator.return(undefined);
      expect(early.observed.closed).toBe(true);
      expect(early.observed.bytes).toBe(pulled);
      expect(pulled).toBeLessThanOrEqual(firstBytes + chunkSize);
    }
  }
});

test('oversized unterminated tails abort with the same byte bound at every scale', async () => {
  for (const source of sources) for (const count of scales) {
    const { bytes, firstBytes } = seed(source, count, true);
    const { input, observed } = supplied(bytes);
    const counters = createDumpCounters();
    await expect((async () => {
      for await (const _record of readDump(source, input, { maxRecordBytes: cap, counters })) { /* drain */ }
    })()).rejects.toBeInstanceOf(Error);
    expect(counters.yieldedRecords).toBe(1);
    expect(observed.closed).toBe(true);
    expect(observed.bytes).toBeLessThanOrEqual(firstBytes + cap + 2 * chunkSize);
    expect(observed.bytes).toBeLessThan(bytes.length);
    expect(counters.peakRetainedBytes).toBeLessThanOrEqual(cap + chunkSize);
  }
});

test('a large supplied chunk is retained once and only the first record is scanned or copied before yield', async () => {
  for (const source of sources) for (const count of scales) {
    const { bytes, firstBytes } = seed(source, count);
    const original = bytes.slice();
    const { input, observed } = supplied(bytes, bytes.length);
    const counters = createDumpCounters();
    const iterator = readDump(source, input, { maxRecordBytes: cap, counters });
    expect((await iterator.next()).done).toBe(false);
    expect(counters.scannedBytes).toBeLessThanOrEqual(firstBytes);
    expect(counters.copiedBytes).toBeLessThanOrEqual(3 * firstBytes);
    expect(counters.peakBufferBytes).toBeLessThanOrEqual(cap);
    expect(counters.peakRetainedBytes).toBeLessThanOrEqual(bytes.length + cap);
    expect(observed.chunks).toBe(1);
    await iterator.return(undefined);
    expect(observed.closed).toBe(true);
    expect(bytes).toEqual(original);
  }
});
