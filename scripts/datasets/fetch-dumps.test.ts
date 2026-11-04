import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import {
  fetchVndbDump,
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
  await writeFile(join(root, 'schema_vndbid.sql'), 'CREATE TYPE vndbid;\n');
  await mkdir(join(root, 'db'));
  for (const table of VNDB_DUMP_TABLES) {
    await writeFile(join(root, 'db', table), 'v1\n');
    const header = (VNDB_DUMP_HEADERS[table] ?? VNDB_DUMP_REQUIRED_COLUMNS[table] ?? ['id']).join('\t');
    await writeFile(join(root, 'db', `${table}.header`), `${header}\n`);
  }
  const proc = Bun.spawn(['tar', '--zstd', '-cf', archive, '-C', root, 'README.txt', 'schema_vndbid.sql', 'db'], {
    stderr: 'pipe',
    stdout: 'ignore',
  });
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
    extlinks: ['id', 'site', 'value'],
    staff_extlinks: ['id', 'link'],
    producers_extlinks: ['id', 'link'],
    releases_extlinks: ['id', 'link'],
    vn_extlinks: ['id', 'link'],
    tags: ['id', 'cat', 'defaultspoil', 'searchable', 'applicable', 'name', 'alias', 'description'],
    tags_parents: ['id', 'parent', 'main'],
    tags_vn: ['date', 'tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore', 'lie', 'notes'],
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

test("When the pinned VNDB dump URL is gone, the fetch resolves the current dump from VNDB's published dump index (or the documented durable location), verifies it, and records the resolved file and checksum; it never silently seeds without VNDB.", async () => {
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
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === VNDB_ARCHIVE_URL) return new Response('gone', { status: 404 });
      if (url === VNDB_DUMP_INDEX_URL) return new Response(INDEX_HTML);
      if (url === CURRENT_DUMP_URL) return new Response(bytes);
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await fetchVndbDump({ cacheRoot, fetchImpl });
    expect(result.manifest).toEqual({
      file: 'vndb-db-2026-11-03.tar.zst',
      url: CURRENT_DUMP_URL,
      sha256: digest,
    });
    expect(JSON.parse(await readFile(vndbDumpManifestPath(cacheRoot), 'utf8'))).toEqual(result.manifest);
    expect(await readFile(result.vndbArchive)).toEqual(bytes);
    expect(await readFile(join(result.vndb, 'README.txt'), 'utf8')).toBe('VNDB dump\n');
    expect(seen).toEqual([VNDB_ARCHIVE_URL, VNDB_DUMP_INDEX_URL, CURRENT_DUMP_URL]);
    await rm(join(result.vndb, 'db', 'chars_names'));
    await rm(join(result.vndb, 'db', 'chars_names.header'));
    const refreshed = await fetchVndbDump({ cacheRoot, fetchImpl });
    expect(refreshed.manifest).toEqual(result.manifest);
    expect(await readFile(join(refreshed.vndb, 'db', 'chars_names.header'), 'utf8')).toBe('id\tlang\tname\tlatin\n');
    expect(await readFile(join(refreshed.vndb, 'db', 'chars_names'), 'utf8')).toBe('v1\n');

    await rm(join(result.vndb, 'db', 'releases_media'));
    await rm(join(result.vndb, 'db', 'releases_platforms.header'));
    const repaired = await fetchVndbDump({ cacheRoot, fetchImpl });
    expect(repaired.vndb).toBe(result.vndb);
    expect(await readFile(join(repaired.vndb, 'db', 'releases_media'), 'utf8')).toBe('v1\n');
    expect(await readFile(join(repaired.vndb, 'db', 'releases_platforms.header'), 'utf8')).toBe('id\tplatform\n');
  } finally {
    await dispose();
  }
});

test('VNDB fetch fails when the dump index lists no database dump', async () => {
  const { cacheRoot, dispose } = await tempCache();
  try {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === VNDB_ARCHIVE_URL) return new Response('gone', { status: 404 });
      if (url === VNDB_DUMP_INDEX_URL)
        return new Response(
          '<a href="vndb-tags-latest.json.gz">vndb-tags-latest.json.gz</a><td>vndb-tags-2026-11-04.json.gz</td>',
        );
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchVndbDump({ cacheRoot, fetchImpl })).rejects.toThrow(
      'VNDB dump index does not list a current database dump',
    );
    await expect(readFile(vndbDumpManifestPath(cacheRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await dispose();
  }
});

test('`task seed:dev` documentation states what happens when an upstream dump rotates', async () => {
  const docs = await readFile(resolve(import.meta.dir, '../../docs/development/local-stack.md'), 'utf8');
  expect(docs).toContain('task seed:dev');
  expect(docs).toContain('https://dl.vndb.org/dump/');
  expect(docs).toContain('vndb/manifest.json');
  expect(docs).toMatch(/rotat/);
  expect(docs).toContain('does not continue with Bangumi alone');
});
