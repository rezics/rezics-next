import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { runDevelopmentSeed } from '../../../scripts/datasets/cross-media-seed.ts';
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

test('development seed fetches the shared cache once and passes the local persona to the importer', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const key = join(root, '.temp', 'persona.key');
  const args: string[] = [];
  let fetches = 0;
  await runDevelopmentSeed({
    root,
    env: {
      REZICS_DEV_PERSONA_ACCOUNT_KEY: key,
      REZICS_DEV_PERSONA_ACCOUNT: 'local-importer',
      REZICS_DEV_PERSONA_CLIENT: 'local-cli',
      REZICS_DEV_VNDB_CHARACTER_VOCABULARY: '/shared/vocabulary.json',
      REZICS_DEV_BANGUMI_GAME_GENRE_BINDINGS: '/private/game-genres.json',
      KERNEL_PORT: '4100',
      AUTH_ORIGIN: 'http://localhost:4300',
    },
    fetchDumps: async () => {
      fetches++;
      return {
        cacheRoot: '/shared/dumps',
        bangumi: '/shared/dumps/bangumi',
        vndb: '/shared/dumps/vndb',
        bangumiArchive: '/shared/dumps/bangumi.zip',
        vndbArchive: '/shared/dumps/vndb.tar.zst',
      };
    },
    runSeed: async (argv) => {
      args.push(...argv);
    },
  });
  const option = (name: string) => args[args.indexOf(name) + 1];
  expect(fetches).toBe(1);
  expect(option('--bangumi')).toBe('/shared/dumps/bangumi');
  expect(option('--vndb')).toBe('/shared/dumps/vndb');
  expect(option('--api')).toBe('http://127.0.0.1:4100');
  expect(option('--auth')).toBe('http://localhost:4300');
  expect(option('--account-key')).toBe(key);
  expect(option('--account')).toBe('local-importer');
  expect(option('--client')).toBe('local-cli');
  expect(option('--vndb-character-vocabulary')).toBe('/shared/vocabulary.json');
  expect(option('--bangumi-game-genre-bindings')).toBe('/private/game-genres.json');
});
