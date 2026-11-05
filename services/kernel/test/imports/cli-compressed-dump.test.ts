import { expect, test } from 'bun:test';
import { openCompressedDumpCli } from './cli-compressed-dump.ts';

test('an operator previews and imports local gzip Open Library and Wikidata dumps with unchanged identity', async () => {
  const f = await openCompressedDumpCli();
  try {
    for (const source of ['openlibrary', 'wikidata'] as const) {
      const plain = source === 'openlibrary' ? f.openlibrary : f.wikidata;
      const keys = source === 'openlibrary' ? ['/works/OL1W', '/works/OL2W'] : ['Q1', 'Q2'];
      const first = await f.invoke(source, plain);
      expect(first.code, first.stderr).toBe(0);
      const afterPlain = f.inspect(first.state, source, keys);
      expect(afterPlain.source.count).toBe(2);
      expect(afterPlain.records.every((row) => row.claim?.state === 'bound')).toBe(true);
      const digests = afterPlain.records.map((row) => row.state.baseline?.digest);

      const previewed = await f.preview(source, f.gzip(plain), ['--compression', 'gzip']);
      expect(previewed.network).toEqual([]);
      expect(previewed.code).toBe(0);
      const document = JSON.parse(previewed.stdout) as { complete: boolean; counts: { admitted: number } };
      expect(document.complete).toBe(true);
      expect(document.counts.admitted).toBe(2);

      const gzipped = await f.invoke(source, f.gzip(plain), ['--compression', 'gzip']);
      expect(gzipped.code, gzipped.stderr).toBe(0);
      expect(gzipped.stdout).toContain('unchanged=2');
      const afterGzip = f.inspect(gzipped.state, source, keys);
      expect(afterGzip.records.map((row) => row.state.baseline?.digest)).toEqual(digests);
      expect(afterGzip.source.count).toBe(2);

      const corrupt = await f.invoke(source, f.gzip(plain).subarray(0, 16), ['--compression', 'gzip']);
      expect(corrupt.code).toBe(2);
      expect(corrupt.exchanges).toEqual([]);
      expect(f.inspect(corrupt.state, source, keys).source.count).toBe(2);
    }
  } finally {
    await f.close();
  }
}, 1_800_000);
