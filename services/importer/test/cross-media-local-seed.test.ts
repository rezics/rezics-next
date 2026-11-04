import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { cacheDumpAsset } from '../../../scripts/datasets/fetch-dumps.ts';
import { normalizeCrossMediaSeedOrigin } from '../src/cross-media-seed.ts';

test('downloads a pinned dump once, verifies it, and reuses its cache', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const tempRoot = join(root, '.temp');
  await mkdir(tempRoot, { recursive: true });
  const temp = await mkdtemp(join(tempRoot, 'cross-media-local-seed-'));
  const bytes = new TextEncoder().encode('pinned public dump');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  try {
    await mkdir(temp, { recursive: true });
    const path = join(temp, 'dump.zip');
    const fetchImpl: typeof fetch = async () => {
      downloads++;
      return new Response(bytes);
    };
    expect(await cacheDumpAsset('https://example.test/dump.zip', path, digest, { fetchImpl })).toBe(digest);
    expect(await cacheDumpAsset('https://example.test/dump.zip', path, digest, { fetchImpl })).toBe(digest);
    expect(downloads).toBe(1);
    expect(await readFile(path)).toEqual(bytes);
    await writeFile(path, 'corrupt cache');
    expect(await cacheDumpAsset('https://example.test/dump.zip', path, digest, { fetchImpl })).toBe(digest);
    expect(downloads).toBe(2);
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('seed origins allow loopback HTTP and require HTTPS elsewhere', () => {
  expect(normalizeCrossMediaSeedOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
  expect(normalizeCrossMediaSeedOrigin('https://imports.example.test')).toBe('https://imports.example.test');
  expect(() => normalizeCrossMediaSeedOrigin('http://imports.example.test')).toThrow(
    'Seed API and Auth require HTTPS origins or loopback HTTP origins',
  );
});
