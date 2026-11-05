import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createGzipDumpCounters, decodeDumpBytes, gzipHighWaterMark } from '../src/compressed-dump.ts';
import { readDump } from '../src/dumps.ts';
import { createDumpCounters, observeDumpRetention } from '../src/dumps-bytes.ts';

const scales = [32, 128, 512] as const;
const encode = (text: string) => new TextEncoder().encode(text);
const window = gzipHighWaterMark();

function seed(source: 'openlibrary' | 'wikidata', count: number) {
  const title = 'a'.repeat(64);
  const rows = Array.from({ length: count }, (_, index) => {
    const id = 1000 + index;
    return source === 'openlibrary'
      ? `/type/work\t/works/OL${id}W\t7\t2024-01-01\t${JSON.stringify({
          key: `/works/OL${id}W`,
          type: { key: '/type/work' },
          revision: 7,
          title,
        })}`
      : JSON.stringify({ id: `Q${id}`, type: 'item', lastrevid: 7, title });
  });
  const text = source === 'wikidata' ? `[\n${rows.join(',\n')}\n]\n` : `${rows.join('\n')}\n`;
  return encode(text);
}

test('raw and gzip dump paths stay linear at 32/128/512 with bounded windows and a slow consumer', async () => {
  const signal = new AbortController().signal;
  for (const source of ['openlibrary', 'wikidata'] as const) {
    const samples: { count: number; compressed: number; decoded: number; visits: number; peak: number }[] = [];
    for (const count of scales) {
      const plain = seed(source, count);
      const gzip = gzipSync(plain, { level: 9 });
      expect(gzip.byteLength).toBeLessThan(plain.byteLength);
      const counters = createGzipDumpCounters();
      const dump = createDumpCounters();
      let peak = 0;
      const stop = observeDumpRetention((sample) => {
        peak = Math.max(peak, sample.total);
      });
      let yielded = 0;
      try {
        for await (const _record of readDump(
          source,
          decodeDumpBytes(
            (async function* () {
              for (let offset = 0; offset < gzip.byteLength; offset += 37) yield gzip.subarray(offset, offset + 37);
            })(),
            { compression: 'gzip', signal, counters, highWaterMark: 64 },
          ),
          { counters: dump, maxChunkBytes: 64, maxRecordBytes: 512 },
        )) {
          yielded++;
          await Promise.resolve();
        }
      } finally {
        stop();
      }
      expect(yielded).toBe(count);
      expect(counters.decodedBytes).toBe(plain.byteLength);
      expect(counters.compressedBytes).toBe(gzip.byteLength);
      expect(counters.peakDecodedWindow).toBeLessThanOrEqual(64);
      expect(counters.peakCompressedWindow).toBeLessThanOrEqual(64);
      expect(peak).toBeLessThanOrEqual(64 + 10 * 514 + 4096);
      samples.push({
        count,
        compressed: counters.compressedBytes,
        decoded: counters.decodedBytes,
        visits: counters.decodeVisits,
        peak,
      });

      const raw = createDumpCounters();
      let rawYield = 0;
      for await (const _record of readDump(
        source,
        (async function* () {
          yield plain;
        })(),
        { counters: raw },
      ))
        rawYield++;
      expect(rawYield).toBe(count);
    }
    expect(samples[1]!.count / samples[0]!.count).toBe(4);
    expect(samples[2]!.count / samples[1]!.count).toBe(4);
    expect(samples[1]!.decoded / samples[0]!.decoded).toBeCloseTo(4, 0);
    expect(samples[2]!.decoded / samples[1]!.decoded).toBeCloseTo(4, 0);
    expect(samples[2]!.peak).toBeLessThanOrEqual(window);
    expect(samples.every((sample) => sample.visits > 0)).toBe(true);
  }
});
