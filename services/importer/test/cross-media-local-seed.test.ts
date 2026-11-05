import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { developmentShowcaseSelection, runDevelopmentSeed } from '../../../scripts/datasets/cross-media-seed.ts';
import { cacheDumpAsset } from '../../../scripts/datasets/fetch-dumps.ts';
import { normalizeCrossMediaSeedOrigin } from '../src/cross-media-seed.ts';

test('downloads a pinned dump once, verifies it, and reuses its cache', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const tempRoot = join(root, '.temp');
  await mkdir(tempRoot, { recursive: true });
  const temp = await mkdtemp(join(tempRoot, 'cross-media-local-seed-'));
  const bytes = Buffer.from('pinned public dump');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  try {
    await mkdir(temp, { recursive: true });
    const path = join(temp, 'dump.zip');
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        downloads++;
        return new Response(bytes);
      },
      { preconnect() {} },
    );
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

for (const configured of [true, false])
  test(`development seed binds the local persona and ${configured ? 'uploads the private export' : 'keeps missing input unavailable'}`, async () => {
    const tempRoot = resolve(import.meta.dir, '../../../.temp');
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, 'cross-media-wrapper-'));
    const keyDirectory = await mkdtemp(join(tempRoot, 'cross-media-persona-key-'));
    const key = join(keyDirectory, 'persona.key');
    const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    await writeFile(key, JSON.stringify({ ...jwk, alg: 'ES256', kid: '11111111-1111-4111-8111-111111111111' }), {
      mode: 0o600,
    });
    const args: string[] = [];
    let passedOptions: unknown;
    let fetches = 0;
    const credentialScopes: string[][] = [];
    const sourceSnapshots = {
      bangumi: {
        file: 'fixture.zip',
        url: 'https://archive.example.test/fixture.zip',
        sha256: 'a'.repeat(64),
        licences: ['CC-BY-SA-3.0'],
      },
      vndb: {
        file: 'fixture.tar.zst',
        url: 'https://dump.example.test/fixture.tar.zst',
        sha256: 'b'.repeat(64),
        timestamp: '2026-11-04 08:00:24+00',
        licences: ['ODbL-1.0', 'DbCL-1.0'],
      },
    };
    const report = {
      readings: [],
      workLinks: [],
      persona: { status: 'incomplete' as const, collections: [], sources: [], workLinks: [] },
    };
    const xml = '<vndb-export version="1.0"><vns><vn id="v2002" /></vns></vndb-export>';
    const exportPath = join(keyDirectory, 'private-export.xml');
    await writeFile(exportPath, xml, { mode: 0o600 });
    const uploadId = '01900000-0000-4000-8000-000000000001';
    const uploads: { path: string; authorization: string | null; key: string | null; body: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        uploads.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        return Response.json({ uploadId, rows: 1 });
      },
    });
    try {
      const result = await runDevelopmentSeed({
        root,
        env: {
          REZICS_DEV_PERSONA_ACCOUNT_KEY: key,
          REZICS_DEV_PERSONA_ACCOUNT: 'local-importer',
          REZICS_DEV_PERSONA_CLIENT: 'local-cli',
          REZICS_DEV_SHOWCASE_ACCOUNT_KEY: key,
          REZICS_DEV_SHOWCASE_CLIENT: 'local-showcase',
          REZICS_DEV_VNDB_CHARACTER_VOCABULARY: '/shared/vocabulary.json',
          REZICS_DEV_BANGUMI_GAME_GENRE_BINDINGS: '/private/game-genres.json',
          ...(configured ? { REZICS_DEV_VNDB_EXPORT: exportPath } : {}),
          KERNEL_ORIGIN: server.url.origin,
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
            sourceSnapshots,
          };
        },
        seedCatalogue: async () => ({ subjects: {}, facts: [] }),
        createTokenProvider: async (configuration) => {
          credentialScopes.push([...(configuration.scopes ?? [])]);
          return async () => 'local-unit-credential';
        },
        runSeed: async (argv, seedOptions) => {
          args.push(...argv);
          passedOptions = seedOptions;
          await writeFile(join(root, '.temp/cross-media-seed/result.json'), JSON.stringify(report));
          return report as never;
        },
      });
      const option = (name: string) => args[args.indexOf(name) + 1];
      expect(fetches).toBe(1);
      expect(result.collections).toBe(report.persona);
      expect(result.sourceSnapshots).toBe(sourceSnapshots);
      expect(result.sourcePublication).toEqual({
        state: 'unavailable',
        assertions: 0,
        omissions: 0,
        code: 'publication-result-missing',
      });
      expect(result).toMatchObject({ state: 'incomplete', community: { state: 'missing_source' } });
      expect(result.personalList).toEqual(
        configured ? { state: 'uploaded', uploadId, rows: 1 } : { state: 'unavailable', code: 'export-not-configured' },
      );
      expect(uploads).toEqual(
        configured
          ? [
              {
                path: '/v1/libraryImports/vndb:preview',
                authorization: 'Bearer local-unit-credential',
                key: expect.any(String),
                body: { xml },
              },
            ]
          : [],
      );
      expect((await stat(join(root, '.temp/cross-media-seed'))).mode & 0o777).toBe(0o700);
      for (const name of ['showcase.sqlite', 'result.json'])
        expect((await stat(join(root, '.temp/cross-media-seed', name))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result)).not.toContain(xml);
      expect(JSON.stringify(result)).not.toContain(exportPath);
      expect(
        JSON.parse(await readFile(join(root, '.temp/cross-media-seed/result.json'), 'utf8')).developmentShowcase,
      ).toEqual(result);
      expect(option('--bangumi')).toBe('/shared/dumps/bangumi');
      expect(option('--vndb')).toBe('/shared/dumps/vndb');
      expect(option('--api')).toBe(server.url.origin);
      expect(option('--auth')).toBe('http://localhost:4300');
      expect(option('--account-key')).toBe(key);
      expect(option('--account')).toBe('local-importer');
      expect(option('--client')).toBe('local-cli');
      expect(option('--vndb-character-vocabulary')).toBe('/shared/vocabulary.json');
      expect(option('--bangumi-game-genre-bindings')).toBe('/private/game-genres.json');
      expect(args).not.toContain('--vndb-credit-bindings');
      expect(args).not.toContain('--vndb-character-profile-bindings');
      expect(developmentShowcaseSelection).toMatchObject({
        bangumi: [10380, 84148, 51],
        vndb: ['v2002', 'v4'],
        includeReleases: true,
      });
      expect(passedOptions).toMatchObject({
        includeBooks: true,
        selection: developmentShowcaseSelection,
        composePersona: expect.any(Function),
      });
      expect(credentialScopes[0]).not.toContain('collection:create');
      expect(credentialScopes[1]).toEqual([
        'subject:read',
        'collection:create',
        'collection:read',
        'collection:update',
      ]);
      expect(credentialScopes[2]).toContain('library_entry:update');
    } finally {
      await server.stop(true);
      await rm(keyDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
