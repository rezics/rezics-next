import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { importRequestFailure } from '../../services/importer/src/import-fetch.ts';
import {
  cacheDumpAsset,
  fetchVndbDump,
  DEVELOPMENT_VNDB_PIN,
  parseVndbDumpIndex,
  VNDB_ARCHIVE_URL,
  VNDB_DUMP_INDEX_URL,
  VNDB_DUMP_HEADERS,
  VNDB_DUMP_REQUIRED_COLUMNS,
  VNDB_DUMP_TABLES,
  vndbDumpManifestPath,
} from './fetch-dumps.ts';

const INDEX_HTML = `<h1>VNDB Database Downloads</h1>
<h2>Latest versions</h2>
<table>
<tr><td><a href="vndb-db-latest.tar.zst">vndb-db-latest.tar.zst</a></td><td>vndb-db-2026-11-03.tar.zst</td></tr>
<tr><td><a href="vndb-tags-latest.json.gz">vndb-tags-latest.json.gz</a></td><td>vndb-tags-2026-11-04.json.gz</td></tr>
</table>
<h2>Files</h2>
<table>
<tr><td><a href="vndb-db-2026-11-03.tar.zst">vndb-db-2026-11-03.tar.zst</a></td></tr>
</table>`;

const CURRENT_DUMP_URL = 'https://dl.vndb.org/dump/vndb-db-2026-11-03.tar.zst';

async function packVndbArchive(archive: string): Promise<void> {
  // Authored table files and headers; this fixture is not observed provider data.
  const root = await mkdtemp(`${archive}.src-`);
  await writeFile(join(root, 'README.txt'), 'VNDB dump\n');
  await writeFile(join(root, 'TIMESTAMP'), `${DEVELOPMENT_VNDB_PIN.timestamp}\n`);
  await writeFile(join(root, 'schema_vndbid.sql'), 'CREATE TYPE vndbid;\n');
  await mkdir(join(root, 'db'));
  for (const table of VNDB_DUMP_TABLES) {
    await writeFile(join(root, 'db', table), 'v1\n');
    const header = (VNDB_DUMP_HEADERS[table] ?? VNDB_DUMP_REQUIRED_COLUMNS[table] ?? ['id']).join('\t');
    await writeFile(join(root, 'db', `${table}.header`), `${header}\n`);
  }
  const proc = Bun.spawn(
    ['tar', '--zstd', '-cf', archive, '-C', root, 'README.txt', 'TIMESTAMP', 'schema_vndbid.sql', 'db'],
    {
      stderr: 'pipe',
      stdout: 'ignore',
    },
  );
  const status = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  await rm(root, { recursive: true, force: true });
  if (status !== 0) throw new Error(`tar failed: ${stderr.trim()}`);
}

async function tempCache(): Promise<{ cacheRoot: string; dispose: () => Promise<void> }> {
  const root = resolve(import.meta.dir, '../..');
  const tempRoot = join(root, '.temp');
  await mkdir(tempRoot, { recursive: true });
  const temp = await mkdtemp(join(tempRoot, 'vndb-dump-fetch-'));
  return { cacheRoot: join(temp, 'cache'), dispose: () => rm(temp, { recursive: true, force: true }) };
}

test('VNDB dump cache requires admitted character-name, external-link, and release-classification tables with exact COPY headers', () => {
  expect(VNDB_DUMP_TABLES).toContain('releases_titles');
  expect(VNDB_DUMP_TABLES).toEqual(
    expect.arrayContaining(['chars_names', 'chars_alias', 'releases_media', 'releases_platforms']),
  );
  expect(VNDB_DUMP_HEADERS.chars_names).toEqual(['id', 'lang', 'name', 'latin']);
  expect(VNDB_DUMP_HEADERS.chars_alias).toEqual(['id', 'spoil', 'name', 'latin']);
  expect(VNDB_DUMP_TABLES).toEqual(
    expect.arrayContaining([
      'extlinks',
      'staff_extlinks',
      'producers_extlinks',
      'releases_extlinks',
      'vn_extlinks',
      'tags',
      'tags_parents',
      'tags_vn',
      'releases_media',
      'releases_platforms',
    ]),
  );
  expect(VNDB_DUMP_HEADERS).toMatchObject({
    chars_traits: ['id', 'tid', 'spoil', 'lie'],
    extlinks: ['id', 'site', 'value'],
    staff_extlinks: ['id', 'link'],
    producers_extlinks: ['id', 'link'],
    releases_extlinks: ['id', 'link'],
    vn_extlinks: ['id', 'link'],
    tags: ['id', 'cat', 'defaultspoil', 'searchable', 'applicable', 'name', 'alias', 'description'],
    tags_parents: ['id', 'parent', 'main'],
    tags_vn: ['date', 'tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore', 'lie', 'notes'],
    traits: [
      'id',
      'gid',
      'gorder',
      'defaultspoil',
      'sexual',
      'searchable',
      'applicable',
      'name',
      'alias',
      'description',
    ],
    releases_media: ['id', 'medium', 'qty'],
    releases_platforms: ['id', 'platform'],
  });
  expect(VNDB_DUMP_TABLES).toContain('releases_titles');
  expect(VNDB_DUMP_TABLES).toEqual(expect.arrayContaining(['chars_traits', 'traits', 'traits_parents']));
  expect(VNDB_DUMP_REQUIRED_COLUMNS).toMatchObject({
    chars_traits: ['id', 'tid', 'spoil', 'lie'],
    chars_vns: ['id', 'vid', 'rid', 'role', 'spoil'],
    traits: ['id', 'name'],
    traits_parents: ['id', 'parent', 'main'],
  });
});

test('dump download failures retain structured local fields and keep the upstream cause private', async () => {
  const { cacheRoot, dispose } = await tempCache();
  try {
    const url = 'https://operator:secret@dl.vndb.org/dump/vndb-db.tar.zst?token=private#fragment';
    const cause = Object.assign(new Error('Bearer abc123 raw imported record body'), { code: 'ECONNRESET' });
    const fetchImpl = Object.assign(
      async () => {
        throw cause;
      },
      { preconnect() {} },
    );
    const failure = await cacheDumpAsset(url, join(cacheRoot, 'downloads', 'vndb-db.tar.zst'), '0'.repeat(64), {
      fetchImpl,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBe(cause);
    expect(importRequestFailure(failure)).toMatchObject({
      operation: 'dump-download',
      phase: 'network',
      method: 'GET',
      origin: 'https://dl.vndb.org',
      path: '/dump/vndb-db.tar.zst',
      networkCode: 'ECONNRESET',
    });
  } finally {
    await dispose();
  }
});

for (const pinned of [false, true]) {
  test(
    pinned
      ? 'Pinned VNDB acquisition replaces stale manifests, reopens exact bytes and refuses changed or missing snapshots'
      : 'Rotating VNDB acquisition resolves a missing archive through the index and reopens verified bytes',
    async () => {
      expect(parseVndbDumpIndex(INDEX_HTML)).toEqual({
        file: 'vndb-db-2026-11-03.tar.zst',
        url: CURRENT_DUMP_URL,
      });
      const { cacheRoot, dispose } = await tempCache();
      try {
        const packed = `${cacheRoot}.packed.tar.zst`;
        await packVndbArchive(packed);
        const bytes = await readFile(packed);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const pin = pinned ? { ...DEVELOPMENT_VNDB_PIN, sha256: digest } : undefined;
        const expectedUrl = pinned ? VNDB_ARCHIVE_URL : CURRENT_DUMP_URL;
        const expectedFile = expectedUrl.split('/').at(-1)!;
        if (pin) {
          await mkdir(join(cacheRoot, 'downloads'), { recursive: true });
          await mkdir(join(cacheRoot, 'vndb'), { recursive: true });
          await writeFile(join(cacheRoot, 'downloads', 'vndb-db-2026-11-03.tar.zst'), bytes);
          await writeFile(
            vndbDumpManifestPath(cacheRoot),
            JSON.stringify({ file: 'vndb-db-2026-11-03.tar.zst', url: CURRENT_DUMP_URL, sha256: digest }),
          );
        }
        const seen: string[] = [];
        let available = true;
        const fetchImpl = Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            seen.push(url);
            if (pinned && available && url === VNDB_ARCHIVE_URL) return new Response(bytes);
            if (url === VNDB_ARCHIVE_URL) return new Response('gone', { status: 404 });
            if (url === VNDB_DUMP_INDEX_URL) return new Response(INDEX_HTML);
            if (url === CURRENT_DUMP_URL) return new Response(bytes);
            throw new Error(`unexpected fetch ${url}`);
          },
          { preconnect() {} },
        );
        const result = await fetchVndbDump({ cacheRoot, fetchImpl, ...(pin ? { pin } : {}) });
        expect(result.manifest).toEqual({
          file: expectedFile,
          url: expectedUrl,
          sha256: digest,
        });
        expect(JSON.parse(await readFile(vndbDumpManifestPath(cacheRoot), 'utf8'))).toEqual(result.manifest);
        expect(await readFile(result.vndbArchive)).toEqual(bytes);
        expect(await readFile(join(result.vndb, 'README.txt'), 'utf8')).toBe('VNDB dump\n');
        expect(seen).toEqual(pinned ? [VNDB_ARCHIVE_URL] : [VNDB_ARCHIVE_URL, VNDB_DUMP_INDEX_URL, CURRENT_DUMP_URL]);
        await rm(join(result.vndb, 'db', 'chars_names'));
        await rm(join(result.vndb, 'db', 'chars_names.header'));
        const refreshed = await fetchVndbDump({ cacheRoot, fetchImpl, ...(pin ? { pin } : {}) });
        expect(refreshed.manifest).toEqual(result.manifest);
        expect(await readFile(join(refreshed.vndb, 'db', 'chars_names.header'), 'utf8')).toBe(
          'id\tlang\tname\tlatin\n',
        );
        expect(await readFile(join(refreshed.vndb, 'db', 'chars_names'), 'utf8')).toBe('v1\n');

        await rm(join(result.vndb, 'db', 'releases_media'));
        await rm(join(result.vndb, 'db', 'releases_platforms.header'));
        const repaired = await fetchVndbDump({ cacheRoot, fetchImpl, ...(pin ? { pin } : {}) });
        expect(repaired.vndb).toBe(result.vndb);
        expect(await readFile(join(repaired.vndb, 'db', 'releases_media'), 'utf8')).toBe('v1\n');
        expect(await readFile(join(repaired.vndb, 'db', 'releases_platforms.header'), 'utf8')).toBe('id\tplatform\n');
        if (pin) {
          expect(seen).toEqual([VNDB_ARCHIVE_URL]);
          await expect(
            fetchVndbDump({ cacheRoot, fetchImpl, pin: { ...pin, timestamp: '2026-11-03 08:00:24+00' } }),
          ).rejects.toThrow('Verified dump is missing required files');
          const mismatch = await fetchVndbDump({
            cacheRoot,
            fetchImpl,
            pin: { ...pin, sha256: '0'.repeat(64) },
          }).catch((error: unknown) => error);
          expect(mismatch).toBeInstanceOf(Error);
          expect((mismatch as Error).message).toContain('Dump SHA-256 mismatch');
          expect(importRequestFailure(mismatch)).toMatchObject({
            operation: 'dump-download',
            phase: 'integrity',
            code: 'sha256-mismatch',
          });
          available = false;
          await rm(join(cacheRoot, 'vndb', expectedFile.replace(/\.tar\.zst$/, '')), {
            recursive: true,
            force: true,
          });
          const unavailable = await fetchVndbDump({ cacheRoot, fetchImpl, pin }).catch((error: unknown) => error);
          expect(unavailable).toBeInstanceOf(Error);
          expect((unavailable as Error).message).toContain('Dump download failed with HTTP 404');
          expect(importRequestFailure(unavailable)).toMatchObject({
            operation: 'dump-download',
            phase: 'http',
            status: 404,
            origin: 'https://dl.vndb.org',
            path: '/dump/vndb-db-2026-11-04.tar.zst',
          });
          expect(seen).toEqual([VNDB_ARCHIVE_URL, VNDB_ARCHIVE_URL, VNDB_ARCHIVE_URL]);
          expect(JSON.parse(await readFile(vndbDumpManifestPath(cacheRoot), 'utf8'))).toEqual(result.manifest);
        }
      } finally {
        await dispose();
      }
    },
  );
}

test('VNDB fetch fails when the dump index lists no database dump', async () => {
  const { cacheRoot, dispose } = await tempCache();
  try {
    const fetchImpl = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === VNDB_ARCHIVE_URL) return new Response('gone', { status: 404 });
        if (url === VNDB_DUMP_INDEX_URL)
          return new Response(
            '<a href="vndb-tags-latest.json.gz">vndb-tags-latest.json.gz</a><td>vndb-tags-2026-11-04.json.gz</td>',
          );
        throw new Error(`unexpected fetch ${url}`);
      },
      { preconnect() {} },
    );
    await expect(fetchVndbDump({ cacheRoot, fetchImpl })).rejects.toThrow(
      'VNDB dump index does not list a current database dump',
    );
    await expect(readFile(vndbDumpManifestPath(cacheRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await dispose();
  }
});

test('a restored pinned VNDB extraction is reused without hashing the archive', async () => {
  const { cacheRoot, dispose } = await tempCache();
  try {
    const packed = `${cacheRoot}.packed.tar.zst`;
    await packVndbArchive(packed);
    const bytes = await readFile(packed);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const pin = { ...DEVELOPMENT_VNDB_PIN, sha256: digest };
    const fetchImpl = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === VNDB_ARCHIVE_URL) return new Response(bytes);
        throw new Error(`unexpected fetch ${url}`);
      },
      { preconnect() {} },
    );
    const first = await fetchVndbDump({ cacheRoot, fetchImpl, pin });
    await writeFile(first.vndbArchive, 'not-the-verified-archive');
    const reused = await fetchVndbDump({ cacheRoot, fetchImpl, pin });
    expect(reused.vndb).toBe(first.vndb);
    expect(reused.manifest).toEqual(first.manifest);
    expect(await readFile(join(reused.vndb, 'README.txt'), 'utf8')).toBe('VNDB dump\n');
    expect(await readFile(reused.vndbArchive, 'utf8')).toBe('not-the-verified-archive');
  } finally {
    await dispose();
  }
});

test('a restored extraction without a pin marker is reused and then marked', async () => {
  const { cacheRoot, dispose } = await tempCache();
  try {
    const packed = `${cacheRoot}.packed.tar.zst`;
    await packVndbArchive(packed);
    const bytes = await readFile(packed);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const pin = { ...DEVELOPMENT_VNDB_PIN, sha256: digest };
    const fetchImpl = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === VNDB_ARCHIVE_URL) return new Response(bytes);
        throw new Error(`unexpected fetch ${url}`);
      },
      { preconnect() {} },
    );
    const first = await fetchVndbDump({ cacheRoot, fetchImpl, pin });
    await rm(join(first.vndb, '.cross-media-dump-sha256'));
    await writeFile(first.vndbArchive, 'not-the-verified-archive');
    const reused = await fetchVndbDump({ cacheRoot, fetchImpl, pin });
    expect(reused.vndb).toBe(first.vndb);
    expect(await readFile(join(reused.vndb, '.cross-media-dump-sha256'), 'utf8')).toBe(`${digest}\n`);
    expect(await readFile(reused.vndbArchive, 'utf8')).toBe('not-the-verified-archive');
  } finally {
    await dispose();
  }
});

test('`task seed:dev` documentation distinguishes its pinned snapshot from rotating acquisition', async () => {
  const docs = await readFile(resolve(import.meta.dir, '../../docs/development/local-stack.md'), 'utf8');
  expect(docs).toContain('task seed:dev');
  expect(docs).toContain('https://dl.vndb.org/dump/');
  expect(docs).toContain('vndb/manifest.json');
  expect(docs).toMatch(/rotat/);
  expect(docs).toContain(DEVELOPMENT_VNDB_PIN.sha256);
  expect(docs).toContain(DEVELOPMENT_VNDB_PIN.timestamp);
  expect(docs).toContain('does not continue with Bangumi alone');
  expect(docs).toContain('/srv/rezics-check/datasets/dumps');
  expect(docs).toContain('Timestamp-verified extracted tables');
});
