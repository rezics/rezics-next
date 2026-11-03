import { expect, test } from 'bun:test';
import { openZstdCli } from './cli-zstd.ts';

test('an operator previews and imports local zstd VNDB and Wikidata dumps with unchanged identity', async () => {
  const f = await openZstdCli();
  try {
    for (const source of ['wikidata', 'vndb'] as const) {
      const plain = source === 'wikidata' ? f.wikidata : f.vndb;
      const keys = source === 'wikidata' ? ['Q1', 'Q2'] : ['v123', 'v124'];
      const first = await f.invoke(source, plain);
      expect(first.code, first.stderr).toBe(0);
      const afterPlain = f.inspect(first.state, source, keys);
      expect(afterPlain.source.count).toBeGreaterThan(0);
      const digests = afterPlain.records.map((row) => row.state.baseline?.digest);

      const compressed = await f.zstd(plain);
      const previewed = await f.preview(source, compressed, ['--compression', 'zstd']);
      expect(previewed.network).toEqual([]);
      expect(previewed.code).toBe(0);
      const document = JSON.parse(previewed.stdout) as { complete: boolean; counts: { admitted: number } };
      expect(document.complete).toBe(true);
      expect(document.counts.admitted).toBeGreaterThan(0);

      const imported = await f.invoke(source, compressed, ['--compression', 'zstd']);
      expect(imported.code, imported.stderr).toBe(0);
      expect(imported.stdout).toContain('unchanged=');
      const afterZstd = f.inspect(imported.state, source, keys);
      expect(afterZstd.records.map((row) => row.state.baseline?.digest)).toEqual(digests);

      const corrupt = await f.invoke(source, compressed.subarray(0, 16), ['--compression', 'zstd']);
      expect(corrupt.code).toBe(2);
      expect(corrupt.exchanges).toEqual([]);
      expect(f.inspect(corrupt.state, source, keys).source.count).toBe(afterPlain.source.count);
    }
  } finally {
    await f.close();
  }
}, 1_800_000);
