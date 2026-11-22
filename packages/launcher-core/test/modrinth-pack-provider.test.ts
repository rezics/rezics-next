import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { ModrinthRequests } from '../src/modrinth-requests.ts';
import { maxPackArchive, packIndexName } from '../src/plugins/modrinth-pack-format.ts';
import { ModrinthPackProvider } from '../src/plugins/modrinth-pack-provider.ts';
import { ModrinthPacks } from '../src/plugins/modrinth-pack.ts';
import { fileInfo } from '../src/storage.ts';

const base = fileURLToPath(new URL('../.temp/', import.meta.url));
const directories: string[] = [];
const projectId = 'A1B2C3D4';
const versionId = 'E5F6G7H8';
const archive = new URL(`https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/pack.mrpack`);
const metadataName = 'Public pack';
const published = '2026-09-14T10:12:10.231681Z';

function digest(content: Uint8Array, algorithm: 'sha1' | 'sha256' | 'sha512') {
  return createHash(algorithm).update(content).digest('hex');
}

async function setup() {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'modrinth-pack-provider-'));
  directories.push(directory);
  const path = join(directory, 'sample.mrpack');
  const downloadRoot = join(directory, 'modrinth-pack-downloads');
  const writer = new ZipFile();
  writer.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        name: 'Archive-specific name',
        versionId: 'archive-specific-version',
        game: 'minecraft',
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
        files: [],
      }),
    ),
    packIndexName,
  );
  writer.addBuffer(Buffer.from('fixture override'), 'overrides/config/readme.txt');
  writer.end();
  await pipeline(writer.outputStream, createWriteStream(path, { flags: 'wx' }));
  const bytes = await readFile(path);
  const asset = {
    primary: true,
    filename: 'pack.mrpack',
    url: archive.href,
    size: bytes.length,
    hashes: { sha1: digest(bytes, 'sha1'), sha512: digest(bytes, 'sha512') },
  };
  const version = {
    id: versionId,
    project_id: projectId,
    version_number: 'Public 1.0',
    name: metadataName,
    date_published: published,
    version_type: 'beta',
    status: 'listed',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    files: [asset],
  };
  const requests: { url: URL; init?: RequestInit }[] = [];
  let project = { id: projectId, project_type: 'modpack' };
  let onDownload = (_url: URL, _init?: RequestInit) => new Response(bytes);
  let describe = () => Response.json(version);
  let onSearch = (options: URLSearchParams) =>
    Response.json({ hits: [], offset: Number(options.get('offset')), total_hits: 0 });
  let onList = () => Response.json([version]);
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, ...(init && { init }) });
    if (url.hostname === 'cdn.modrinth.com') return onDownload(url, init);
    if (url.hostname !== 'api.modrinth.com') throw new Error('Unexpected origin');
    if (url.pathname === '/v2/search') return onSearch(url.searchParams);
    if (url.pathname === `/v2/project/${projectId}`) return Response.json(project);
    if (url.pathname === `/v2/project/${projectId}/version`) return onList();
    if (url.pathname === `/v2/version/${versionId}`) return describe();
    return new Response('Invalid request', { status: 404 });
  }) as typeof fetch;
  const packs = new ModrinthPacks();
  const provider = new ModrinthPackProvider(directory, new ModrinthRequests(fetcher, 'fixture'), packs);
  return {
    directory,
    downloadRoot,
    bytes,
    asset,
    version,
    requests,
    provider,
    fetcher,
    packs,
    setProject: (value: typeof project) => {
      project = value;
    },
    setDownload: (value: typeof onDownload) => {
      onDownload = value;
    },
    setVersion: (value: typeof describe) => {
      describe = value;
    },
    setSearch: (value: typeof onSearch) => {
      onSearch = value;
    },
    setVersions: (value: typeof onList) => {
      onList = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('searches modpack projects and paginates public exact releases without downloading them', async () => {
  const { provider, version, requests, setSearch, setVersions } = await setup();
  const hit = { project_id: projectId, project_type: 'modpack', title: metadataName, description: 'Public summary' };
  setSearch((params) =>
    Response.json({
      hits: params.get('offset') === '0' ? [hit] : [],
      offset: Number(params.get('offset')),
      total_hits: 2,
    }),
  );
  expect(await provider.search('  Public  ')).toEqual({
    items: [{ id: projectId, title: metadataName, summary: 'Public summary' }],
    nextCursor: '1',
  });
  expect(await provider.search('', '1')).toEqual({ items: [], nextCursor: null });
  expect(requests[0]!.url.searchParams.get('facets')).toBe('[["project_type:modpack"]]');
  expect(requests[0]!.url.searchParams.get('query')).toBe('Public');
  expect(requests[1]!.url.searchParams.get('index')).toBe('downloads');
  expect(new Headers(requests[0]!.init?.headers).get('user-agent')).toContain('REZICS/launcher-fixture');
  expect(requests[0]!.init?.redirect).toBe('error');
  await expect(provider.search('Public', '../bad')).rejects.toThrow('cursor');

  setVersions(() =>
    Response.json([
      ...Array.from({ length: 27 }, (_, index) => ({ ...version, id: `Version${index}` })),
      { ...version, id: 'Hidden00', status: 'unlisted' },
      { ...version, id: 'NoPack00', files: [] },
    ]),
  );
  const first = await provider.list(projectId);
  expect(first.items).toHaveLength(25);
  expect(first.items[0]).toEqual({
    id: 'Version0',
    projectId,
    version: 'Public 1.0',
    title: metadataName,
    channel: 'beta',
    publishedAt: published,
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
  });
  expect(first.nextCursor).toBe('25');
  const last = await provider.list(projectId, first.nextCursor!);
  expect(last.items.map(({ id }) => id)).toEqual(['Version25', 'Version26']);
  expect(last.nextCursor).toBeNull();
  expect(requests.some(({ url }) => url.hostname === 'cdn.modrinth.com')).toBeFalse();
  expect(requests.find(({ url }) => url.pathname.endsWith('/version'))?.url.searchParams.get('include_changelog')).toBe(
    'false',
  );

  setVersions(() => Response.json([{ ...version, project_id: 'Mismatched' }]));
  await expect(provider.list(projectId)).rejects.toThrow('different project');
  setSearch(() => Response.json({ hits: [{ ...hit, project_type: 'mod' }], offset: 0, total_hits: 1 }));
  await expect(provider.search('Public')).rejects.toThrow('invalid modpack metadata');
});

test('stages a hashed online archive through the same parser and releases its private lease', async () => {
  const { provider, bytes, requests, downloadRoot, setDownload } = await setup();
  setDownload((url) =>
    url.pathname === archive.pathname
      ? new Response(null, { status: 302, headers: { location: '/confirmed/pack.mrpack' } })
      : new Response(bytes),
  );
  const pack = await provider.stage(projectId, versionId);
  expect(pack.digest).toBe(digest(bytes, 'sha256'));
  expect(pack.preview).toMatchObject({
    name: 'Archive-specific name',
    versionId: 'archive-specific-version',
    selection: { version: '1.21.1', loader: 'fabric', fabricVersion: '0.16.14' },
    overrides: [{ path: 'config/readme.txt', kind: 'shared' }],
  });
  expect((await readFile(pack.source)).equals(bytes)).toBeTrue();
  const binary = requests.filter(({ url }) => url.hostname === 'cdn.modrinth.com');
  expect(binary.map(({ url }) => url.pathname)).toEqual([archive.pathname, '/confirmed/pack.mrpack']);
  expect(binary.every(({ init }) => init?.redirect === 'manual' && init.credentials === 'omit')).toBeTrue();
  await provider.recover();
  expect(await fileInfo(pack.source)).toBeDefined();
  await pack.release();
  await pack.release();
  expect(await fileInfo(pack.source)).toBeUndefined();
  expect(await readdir(downloadRoot)).toEqual([]);
});

test('rejects wrong or malformed release metadata, disallowed redirects, denial, hash failures and incompatible manifests', async () => {
  const { provider, asset, version, bytes, requests, downloadRoot, setDownload, setProject, setVersion } =
    await setup();
  setProject({ id: projectId, project_type: 'mod' });
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('invalid modpack metadata');
  setProject({ id: 'OtherProject', project_type: 'modpack' });
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('different modpack project');
  setProject({ id: projectId, project_type: 'modpack' });

  for (const bad of [
    { ...version, id: 'OtherVersion' },
    { ...version, project_id: 'OtherProject' },
  ]) {
    setVersion(() => Response.json(bad));
    await expect(provider.stage(projectId, versionId)).rejects.toThrow('different or unavailable');
  }
  setVersion(() => Response.json({ ...version, files: [{ ...asset, hashes: { ...asset.hashes, sha1: 'xxx' } }] }));
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('invalid modpack metadata');
  setVersion(() => Response.json({ ...version, files: [{ ...asset, size: maxPackArchive + 1 }] }));
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('512 MiB');
  setVersion(() =>
    Response.json({ ...version, files: [{ ...asset, url: 'https://cdn.modrinth.com.fake.test/pack.mrpack' }] }),
  );
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('official Modrinth CDN');
  expect(await fileInfo(downloadRoot)).toBeUndefined();

  setVersion(() => new Response('No access', { status: 403 }));
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('403');
  setVersion(() => Response.json(version));
  setDownload(
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/archive.mrpack' } }),
  );
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('official Modrinth CDN');
  expect(requests.some(({ url }) => url.hostname === 'elsewhere.test')).toBeFalse();
  setDownload(() => new Response('No access', { status: 403 }));
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('403');
  setDownload(() => new Response(bytes));
  setVersion(() =>
    Response.json({ ...version, files: [{ ...asset, hashes: { ...asset.hashes, sha512: '0'.repeat(128) } }] }),
  );
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('published size and digest');
  setVersion(() =>
    Response.json({ ...version, files: [{ ...asset, hashes: { ...asset.hashes, sha1: '0'.repeat(40) } }] }),
  );
  await expect(provider.stage(projectId, versionId)).rejects.toThrow('SHA-1');
  for (const bad of [
    { ...version, game_versions: ['1.19.1'] },
    { ...version, loaders: ['forge'] },
  ]) {
    setVersion(() => Response.json(bad));
    await expect(provider.stage(projectId, versionId)).rejects.toThrow('does not match the Modrinth release');
  }
  expect(await readdir(downloadRoot)).toEqual([]);
});

test('cleans interrupted downloads at startup, and clears a cancelled archive while staging', async () => {
  const { directory, downloadRoot, provider, bytes, setDownload } = await setup();
  const previous = join(downloadRoot, `pack-${randomUUID()}`);
  const unrelated = join(directory, 'other-data');
  await Promise.all([mkdir(previous, { recursive: true }), mkdir(unrelated)]);
  await writeFile(join(previous, 'contents.mrpack'), 'interrupted part');
  await writeFile(join(unrelated, 'keep.txt'), 'not ours');
  const linked = join(downloadRoot, `pack-${randomUUID()}`);
  await symlink(unrelated, linked, 'junction');
  await provider.recover();
  expect(await fileInfo(previous)).toBeUndefined();
  expect((await fileInfo(linked))?.isSymbolicLink()).toBeTrue();
  expect(await readFile(join(unrelated, 'keep.txt'), 'utf8')).toBe('not ours');

  const controller = new AbortController();
  const downloading = Promise.withResolvers<void>();
  setDownload(
    (_url, init) =>
      new Response(
        new ReadableStream({
          start(chunk) {
            chunk.enqueue(bytes.subarray(0, 1));
            init?.signal?.addEventListener('abort', () => chunk.error(init.signal?.reason), { once: true });
            downloading.resolve();
          },
        }),
      ),
  );
  const staged = provider.stage(projectId, versionId, controller.signal);
  await downloading.promise;
  controller.abort();
  await expect(staged).rejects.toThrow();
  expect(await readdir(downloadRoot)).toEqual([basename(linked)]);
});
