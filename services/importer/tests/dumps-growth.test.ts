import { expect, test } from 'bun:test';
import type { SourceId } from '@rezics/conversion';
import { readDump } from '../src/dumps';
import { createDumpCounters, observeDumpRetention, type DumpRetention } from '../src/dumps-bytes';

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
      case 'bangumi':
        return JSON.stringify({ id, type: 2, name: title });
      case 'vndb':
        return `v${id}\t${title}\t\\N`;
      case 'openlibrary':
        return `/type/work\t/works/OL${id}W\t7\t2024-01-01\t${JSON.stringify({
          key: `/works/OL${id}W`,
          type: { key: '/type/work' },
          revision: 7,
          title,
        })}`;
      case 'wikidata':
        return JSON.stringify({ id: `Q${id}`, type: 'item', lastrevid: 7, title });
    }
  });
  expect(new Set(rows.map((row) => encoder.encode(row).length)).size).toBe(1);
  const header =
    source === 'vndb' ? 'COPY public.vn (id, description, image) FROM stdin;\n' : source === 'wikidata' ? '[\n' : '';
  const separator = source === 'wikidata' ? ',\n' : '\n';
  const footer = source === 'vndb' ? '\n\\.\n' : source === 'wikidata' ? '\n]\n' : '\n';
  const text = oversized
    ? `${header}${rows[0]}${separator}${'x'.repeat(count * cap)}`
    : `${header}${rows.join(separator)}${footer}`;
  return { bytes: encoder.encode(text), firstBytes: encoder.encode(`${header}${rows[0]}${separator}`).length };
}

function supplied(bytes: Uint8Array) {
  const observed = { chunks: 0, bytes: 0, closed: false };
  async function* input() {
    try {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const part = bytes.slice(offset, offset + chunkSize);
        observed.chunks++;
        observed.bytes += part.length;
        yield part;
      }
    } finally {
      observed.closed = true;
    }
  }
  return { input: input(), observed };
}

// dumps-bytes.ts scans each supplied byte once. Appending and geometric growth
// copy at most 3 * input; dumps.ts adds at most 2 * input for COPY cell encoding
// and unescaping (Wikidata re-encoding adds at most input). Thus scans + copies
// <= 6 * input for every source, including framing bytes.
// The live ledger charges full input backings, both overlapping growth buffers
// (<= 2 * lineCap). UTF-16 text and split cells each cost <= 2 * lineCap.
// VNDB's three cell references cost 24 bytes; its largest cell is 64 bytes,
// so encoded/output buffers plus decoded cell add <= 4 * 64 bytes. This fits
// 8 * lineCap, including the short header's temporary column-name Set.
// OpenLibrary adds five references (40 bytes) and a key <= 2 * lineCap;
// Wikidata has text/trimmed text plus either encoded bytes or a UTF-16 key
// (<= 6 * lineCap); Bangumi text/key use <= 4 * lineCap. All fit 8 * lineCap.
// Metadata has 440 bytes of fixed slots/counters, <= 22 source-name bytes,
// and <= 64 COPY table/column bytes here, comfortably below 4096. Thus the
// reader-bounds total is chunkCap + 10 * lineCap + 4096, independent of row count.
// Native framing is included: VNDB permits 65536-byte COPY headers; other lines
// allow the record cap plus newline/CR/comma overhead. Keys never affect lineCap.
function lineCap(source: SourceId) {
  return Math.max(cap + 2, source === 'vndb' ? 65536 : 0);
}

async function retention(source: SourceId, chunkCap: number, operation: () => Promise<void>) {
  const peak: DumpRetention = { input: 0, line: 0, scratch: 0, metadata: 0, total: 0 };
  const stop = observeDumpRetention((sample) => {
    expect(sample.total).toBe(sample.input + sample.line + sample.scratch + sample.metadata);
    expect(sample.input).toBeLessThanOrEqual(chunkCap);
    expect(sample.line).toBeLessThanOrEqual(2 * lineCap(source));
    expect(sample.scratch).toBeLessThanOrEqual(8 * lineCap(source));
    expect(sample.metadata).toBeLessThanOrEqual(4096);
    expect(sample.total).toBeLessThanOrEqual(chunkCap + 10 * lineCap(source) + 4096);
    for (const region of ['input', 'line', 'scratch', 'metadata', 'total'] as const)
      peak[region] = Math.max(peak[region], sample[region]);
  });
  try {
    await operation();
  } finally {
    stop();
  }
  return peak;
}

test('streaming parser growth follows supplied bytes with bounded per-record read-ahead', async () => {
  for (const source of sources) {
    for (const count of scales) {
      const { bytes, firstBytes } = seed(source, count);
      const full = supplied(bytes);
      const counters = createDumpCounters();
      let yielded = 0;
      const peak = await retention(source, chunkSize, async () => {
        for await (const _record of readDump(source, full.input, {
          maxRecordBytes: cap,
          maxChunkBytes: chunkSize,
          counters,
        })) {
          yielded++;
          if (yielded === 1) {
            expect(full.observed.bytes).toBeLessThan(bytes.length);
            expect(full.observed.bytes).toBeLessThanOrEqual(firstBytes + chunkSize);
          }
        }
      });
      expect(yielded).toBe(count);
      expect(counters.yieldedRecords).toBe(count);
      expect(counters.pulledBytes).toBe(bytes.length);
      expect(counters.pulledChunks).toBe(Math.ceil(bytes.length / chunkSize));
      expect(counters.scannedBytes).toBe(bytes.length);
      expect(counters.copiedBytes).toBeGreaterThan(0);
      expect(counters.scannedBytes + counters.copiedBytes).toBeLessThanOrEqual(6 * bytes.length);
      expect(counters.peakBufferBytes).toBeLessThanOrEqual(lineCap(source));
      expect(peak.input).toBe(chunkSize);
      expect(counters.peakRetainedBytes).toBe(peak.total);
      expect(full.observed.closed).toBe(true);

      const early = supplied(bytes);
      const iterator = readDump(source, early.input, { maxRecordBytes: cap, maxChunkBytes: chunkSize });
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
  for (const source of sources)
    for (const count of scales) {
      const { bytes, firstBytes } = seed(source, count, true);
      const { input, observed } = supplied(bytes);
      const counters = createDumpCounters();
      const peak = await retention(source, chunkSize, async () => {
        await expect(
          (async () => {
            for await (const _record of readDump(source, input, {
              maxRecordBytes: cap,
              maxChunkBytes: chunkSize,
              counters,
            })) {
              /* drain */
            }
          })(),
        ).rejects.toBeInstanceOf(Error);
      });
      expect(counters.yieldedRecords).toBe(1);
      expect(observed.closed).toBe(true);
      expect(observed.bytes).toBeLessThanOrEqual(firstBytes + cap + 2 * chunkSize);
      expect(observed.bytes).toBeLessThan(bytes.length);
      expect(counters.peakRetainedBytes).toBe(peak.total);
      expect(counters.scannedBytes).toBeLessThanOrEqual(observed.bytes);
      expect(counters.scannedBytes + counters.copiedBytes).toBeLessThanOrEqual(6 * observed.bytes);
    }
});

test('one fixed admitted backing is charged in full and only the first record is visited before yield', async () => {
  const chunkCap = 262144;
  for (const source of sources)
    for (const count of scales) {
      const { bytes, firstBytes } = seed(source, count);
      expect(bytes.length).toBeLessThan(chunkCap);
      // Deliberately retain a real, fixed large backing through a smaller view.
      // Its size is independent of source totals and must be charged in full.
      const backing = new Uint8Array(chunkCap);
      backing.set(bytes);
      const original = backing.slice();
      const observed = { chunks: 0, closed: false };
      async function* input() {
        try {
          observed.chunks++;
          yield backing.subarray(0, bytes.length);
        } finally {
          observed.closed = true;
        }
      }
      const counters = createDumpCounters();
      const peak = await retention(source, chunkCap, async () => {
        const iterator = readDump(source, input(), { maxRecordBytes: cap, maxChunkBytes: chunkCap, counters });
        try {
          expect((await iterator.next()).done).toBe(false);
          expect(counters.yieldedRecords).toBe(1);
          expect(counters.pulledBytes).toBe(bytes.length);
          expect(counters.scannedBytes).toBeLessThanOrEqual(firstBytes);
          expect(counters.scannedBytes + counters.copiedBytes).toBeLessThanOrEqual(6 * firstBytes);
          expect(counters.peakBufferBytes).toBeLessThanOrEqual(lineCap(source));
          expect(observed.chunks).toBe(1);
        } finally {
          await iterator.return(undefined);
        }
      });
      expect(peak.input).toBe(chunkCap);
      expect(counters.peakRetainedBytes).toBe(peak.total);
      expect(counters.peakRetainedBytes).toBeGreaterThan(chunkCap);
      expect(observed.closed).toBe(true);
      expect(backing).toEqual(original);
    }
});

test('a tiny view on an oversized backing is rejected before admission, scanning or copying', async () => {
  for (const source of sources) {
    let closed = false;
    async function* input() {
      try {
        yield new Uint8Array(chunkSize + 1).subarray(0, 1);
      } finally {
        closed = true;
      }
    }
    const counters = createDumpCounters();
    const peak = await retention(source, chunkSize, async () => {
      await expect(
        readDump(source, input(), {
          maxRecordBytes: cap,
          maxChunkBytes: chunkSize,
          counters,
        }).next(),
      ).rejects.toThrow('Dump chunk backing exceeds byte limit');
    });
    expect(counters.pulledChunks).toBe(1);
    expect(counters.pulledBytes).toBe(0);
    expect(counters.scannedBytes).toBe(0);
    expect(counters.copiedBytes).toBe(0);
    expect(counters.yieldedRecords).toBe(0);
    expect(peak.input).toBe(0);
    expect(counters.peakRetainedBytes).toBe(peak.total);
    expect(closed).toBe(true);
  }
});
