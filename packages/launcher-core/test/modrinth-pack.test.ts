import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackResource } from '../src/plugins/modrinth-pack-format.ts';
import type { PackJournal } from '../src/plugins/modrinth-pack-storage.ts';
import { ModrinthPacks } from '../src/plugins/modrinth-pack.ts';
import { fileInfo, writeJson } from '../src/storage.ts';
import { writeModrinthPack } from './fixtures/modrinth-pack.ts';

const temporary = fileURLToPath(new URL('../.temp/', import.meta.url));
const directories: string[] = [];
const dependencies = { minecraft: '1.21.1', 'fabric-loader': '0.16.14' };
const cdn = 'https://cdn.modrinth.com/data/fixture/versions/1/';
const original = 'original artifact';
const filenames = ['mods/keep.jar', 'mods/old.jar', 'mods/new.jar'];

function resource(path: string, content: string, client?: 'required' | 'optional' | 'unsupported'): PackResource {
  return {
    path,
    hashes: {
      sha1: createHash('sha1').update(content).digest('hex'),
      sha512: createHash('sha512').update(content).digest('hex'),
    },
    downloads: [cdn + path.split('/').at(-1)],
    fileSize: Buffer.byteLength(content),
    ...(client && { env: { client, server: 'required' } }),
  };
}

async function archive(
  directory: string,
  id: string,
  files: PackResource[],
  overrides: Record<string, string | { data: string; mode: number }> = {},
  exactVersions: Record<string, string> = dependencies,
) {
  return writeModrinthPack(
    join(directory, `${id}.mrpack`),
    { formatVersion: 1, game: 'minecraft', versionId: id, name: 'Fixture Pack', files, dependencies: exactVersions },
    overrides,
  );
}

async function setup() {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'modrinth-pack-'));
  directories.push(directory);
  const instance = join(directory, 'instances', 'first');
  const game = join(instance, 'game');
  const peer = join(directory, 'instances', 'peer');
  const peerGame = join(peer, 'game');
  const pack = new ModrinthPacks(((input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!;
    downloaded.push(path);
    const response = responses.get(path);
    return Promise.resolve(
      response instanceof Response ? response : new Response(response, { status: response ? 200 : 404 }),
    );
  }) as typeof fetch);
  const responses = new Map<string, string | Response>();
  const downloaded: string[] = [];
  const put = async (root: string, path: string, text: string) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  return { directory, instance, game, peer, peerGame, pack, put, responses, downloaded };
}

async function contents(root: string, path: string) {
  return readFile(join(root, path), 'utf8');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('installs, updates, and reproducibly exports a pack without touching a world or unmanaged mod', async () => {
  const { directory, instance, game, peer, peerGame, pack, put, responses, downloaded } = await setup();
  const [keep, old, add] = filenames as [string, string, string];
  await put(game, 'saves/Existing/level.dat', 'my world');
  await put(peerGame, 'mods/keep.jar', 'another instance');
  await put(game, 'mods/rezics-individual.jar', 'another managed source');
  const first = await archive(
    directory,
    'first',
    [
      resource(keep, original),
      resource(old, 'remove from instance'),
      resource('mods/optional.jar', 'optional', 'optional'),
      resource('mods/server-only.jar', 'server only', 'unsupported'),
    ],
    {
      'overrides/config/pack.json': 'shared settings',
      'client-overrides/config/pack.json': 'client settings',
      'overrides/options.txt': 'shipped settings',
      'server-overrides/server.properties': 'skip',
    },
  );
  const inspected = await pack.inspect(first);
  expect(inspected.preview).toMatchObject({
    versionId: 'first',
    selection: { version: '1.21.1', loader: 'fabric', fabricVersion: '0.16.14' },
    overrides: [
      { path: 'config/pack.json', bytes: 15, kind: 'client' },
      { path: 'options.txt', bytes: 16, kind: 'shared' },
    ],
  });
  expect(inspected.preview.files.map(({ client }) => client)).toEqual([
    'required',
    'required',
    'optional',
    'unsupported',
  ]);
  expect(downloaded).toEqual([]);
  responses.set('keep.jar', original);
  responses.set('old.jar', 'remove from instance');
  expect(await pack.apply(instance, game, first, inspected.digest, inspected.preview.selection)).toEqual(
    inspected.preview,
  );
  expect(downloaded).toEqual(['keep.jar', 'old.jar']);
  expect(await contents(game, 'config/pack.json')).toBe('client settings');
  expect(await fileInfo(join(game, 'server.properties'))).toBeUndefined();
  expect(await fileInfo(join(game, 'mods/optional.jar'))).toBeUndefined();
  expect((await pack.committedModNames(instance, game)).sort()).toEqual(['keep.jar', 'old.jar']);

  const second = await archive(
    directory,
    'second',
    [resource(keep, 'changed artifact'), resource(add, 'add to instance')],
    {
      'client-overrides/config/pack.json': 'new client settings',
      'overrides/options.txt': 'new shipped settings',
      'overrides/config/user.json': 'new default for existing config',
      'overrides/config/new.json': 'new default for new config',
    },
  );
  await put(game, 'options.txt', 'private live choices');
  await put(game, 'config/user.json', 'existing independent settings');
  responses.set('keep.jar', 'changed artifact');
  responses.set('new.jar', 'add to instance');
  const next = await pack.inspect(second);
  await pack.apply(instance, game, second, next.digest);
  expect(await contents(game, keep)).toBe('changed artifact');
  expect(await contents(game, add)).toBe('add to instance');
  expect(await fileInfo(join(game, old))).toBeUndefined();
  expect(await contents(game, 'options.txt')).toBe('private live choices');
  expect(await contents(game, 'config/pack.json')).toBe('new client settings');
  expect(await contents(game, 'config/user.json')).toBe('existing independent settings');
  expect(await contents(game, 'config/new.json')).toBe('new default for new config');
  expect(await contents(game, 'saves/Existing/level.dat')).toBe('my world');
  expect(await contents(peerGame, keep)).toBe('another instance');
  expect(await contents(game, 'mods/rezics-individual.jar')).toBe('another managed source');
  expect(await pack.current(instance, game)).toEqual(next.preview);
  expect((await pack.committedModNames(instance, game)).sort()).toEqual(['keep.jar', 'new.jar']);
  expect(await pack.repair(instance, game, next.preview.selection)).toBe(0);

  const output = await pack.export(instance, game, join(directory, 'exported.mrpack'));
  const repeat = await pack.export(instance, game, join(directory, 'repeat.mrpack'));
  expect(await readFile(output)).toEqual(await readFile(repeat));
  await expect(pack.export(instance, game, output)).rejects.toThrow('new file');
  await expect(pack.export(instance, game, join(peerGame, 'invalid.mrpack'))).rejects.toThrow('outside');
  const portable = await pack.inspect(output);
  expect(portable.preview).toEqual(next.preview);
  await expect(pack.apply(peer, peerGame, output, portable.digest)).rejects.toThrow('unmanaged');
  expect(await contents(peerGame, keep)).toBe('another instance');
  await rm(join(peerGame, keep));
  await pack.apply(peer, peerGame, output, portable.digest);
  expect(await contents(peerGame, 'options.txt')).toBe('new shipped settings');
  expect(await contents(peerGame, 'config/user.json')).toBe('new default for existing config');
});

test('cancels a staged update, keeps the original instance, and retries the same archive', async () => {
  const { directory, instance, game, pack, put, responses } = await setup();
  const first = await archive(directory, 'before', [], { 'overrides/config/pack.json': 'original settings' });
  const previous = await pack.inspect(first);
  await pack.apply(instance, game, first, previous.digest);
  await put(game, 'saves/One/level.dat', 'existing world');
  await put(game, 'mods/independent.jar', 'independent mod');
  const incoming = await archive(directory, 'after', [resource('mods/new.jar', original)]);
  const { digest, preview } = await pack.inspect(incoming);
  const receiving = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let sentFirstChunk = false;
  responses.set(
    'new.jar',
    new Response(
      new ReadableStream(
        {
          pull(stream) {
            if (sentFirstChunk) return disconnected.promise;
            sentFirstChunk = true;
            stream.enqueue(Buffer.of(1));
            receiving.resolve();
          },
          cancel() {
            disconnected.resolve();
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  const stop = new AbortController();
  let commits = 0;
  const abandoned = pack.apply(instance, game, incoming, digest, undefined, {
    signal: stop.signal,
    beginCommit() {
      commits += 1;
    },
  });
  const failure = abandoned.catch((error: unknown) => error);
  await receiving.promise;
  stop.abort(new Error('Fixture requested cancellation.'));
  expect(await failure).toBe(stop.signal.reason);
  await disconnected.promise;
  expect(commits).toBe(0);
  expect(await fileInfo(join(instance, 'modrinth-pack-staging'))).toBeUndefined();
  expect(await fileInfo(join(game, 'mods/new.jar'))).toBeUndefined();
  expect(await pack.current(instance, game)).toEqual(previous.preview);
  expect(await contents(game, 'config/pack.json')).toBe('original settings');
  const retry = new AbortController();
  responses.set('new.jar', original);
  expect(
    await pack.apply(instance, game, incoming, digest, undefined, {
      signal: retry.signal,
      beginCommit() {
        commits += 1;
        retry.abort(new Error('The publication boundary has been reached.'));
      },
    }),
  ).toEqual(preview);
  expect(commits).toBe(1);
  expect(await contents(game, 'mods/new.jar')).toBe(original);
  expect(await contents(game, 'saves/One/level.dat')).toBe('existing world');
  expect(await contents(game, 'mods/independent.jar')).toBe('independent mod');
});

test.each(['file', 'directory', 'edit'] as const)(
  'keeps the installed release intact when a late %s blocks publishing its update',
  async (conflict) => {
    const { directory, instance, game, pack, put, responses } = await setup();
    const source = await archive(directory, 'before-conflict', [resource('mods/keep.jar', original)], {
      'overrides/config/pack.json': 'previous',
      'overrides/config/z.json': 'previous setting',
    });
    await put(game, 'saves/One/level.dat', 'existing world');
    await put(game, 'mods/independent.jar', 'independent mod');
    responses.set('keep.jar', original);
    const before = await pack.inspect(source);
    await pack.apply(instance, game, source, before.digest);

    const updated = await archive(
      directory,
      'update-conflict',
      [resource('mods/keep.jar', original), resource('mods/new.jar', 'new download')],
      {
        'overrides/config/pack.json': 'next version',
        'overrides/config/z.json': 'next setting',
      },
    );
    responses.set('new.jar', 'new download');
    const after = await pack.inspect(updated);
    const obstacle = conflict === 'edit' ? 'config/z.json' : 'mods/new.jar';
    const target = join(game, obstacle);
    await expect(
      pack.apply(instance, game, updated, after.digest, undefined, {
        signal: new AbortController().signal,
        beginCommit() {
          if (conflict === 'directory') mkdirSync(target);
          else writeFileSync(target, conflict === 'file' ? 'new download' : 'edited by player');
        },
      }),
    ).rejects.toThrow(
      conflict === 'edit'
        ? `changed before it could be updated (${obstacle})`
        : `occupies the Modrinth path (${obstacle})`,
    );

    expect(await pack.current(instance, game)).toEqual(before.preview);
    expect(await pack.firstDamagedDownload(instance, game)).toBeUndefined();
    expect(await contents(game, 'config/pack.json')).toBe('previous');
    expect(await contents(game, 'saves/One/level.dat')).toBe('existing world');
    expect(await contents(game, 'mods/independent.jar')).toBe('independent mod');
    if (conflict === 'directory') expect((await fileInfo(target))?.isDirectory()).toBe(true);
    else expect(await contents(game, obstacle)).toBe(conflict === 'file' ? 'new download' : 'edited by player');
    expect(await fileInfo(join(instance, 'modrinth-pack-staging'))).toBeUndefined();

    if (conflict === 'edit') await writeFile(target, 'previous setting');
    else await rm(target, { recursive: true });
    expect(await pack.apply(instance, game, updated, after.digest)).toEqual(after.preview);
    expect(await contents(game, 'config/pack.json')).toBe('next version');
    expect(await contents(game, 'mods/new.jar')).toBe('new download');
  },
);

test('rejects stale preview, different lanes, denied downloads, and both resource hash mismatches before committing', async () => {
  const { directory, instance, game, pack, put, responses, downloaded } = await setup();
  const first = await archive(directory, 'first', [resource('mods/keep.jar', original)], {
    'overrides/resourcepacks/Pack/pack.mcmeta': 'resource-pack metadata',
  });
  responses.set('keep.jar', original);
  const preview = await pack.inspect(first);
  await pack.apply(instance, game, first, preview.digest);

  const different = await archive(directory, 'different', [], {}, { minecraft: '1.20.1', forge: '47.4.0' });
  const changedLane = await pack.inspect(different);
  expect(changedLane.preview.selection).toEqual({ version: '1.20.1', loader: 'forge', forgeVersion: '47.4.0' });
  await expect(pack.apply(instance, game, different, changedLane.digest)).rejects.toThrow('exact');
  await expect(pack.apply(instance, game, different, preview.digest)).rejects.toThrow('changed');
  expect(downloaded).toEqual(['keep.jar']);

  const expected = resource('mods/new.jar', 'valid bytes');
  const denied = await archive(directory, 'denied', [expected]);
  const next = await pack.inspect(denied);
  await expect(pack.apply(instance, game, denied, next.digest)).rejects.toThrow('404');
  responses.set('new.jar', 'wrong bytes');
  await expect(pack.apply(instance, game, denied, next.digest)).rejects.toThrow('published size and digest');
  responses.set('new.jar', new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/resource' } }));
  await expect(pack.apply(instance, game, denied, next.digest)).rejects.toThrow('approved hosts');
  expect(downloaded).toEqual(['keep.jar', 'new.jar', 'new.jar', 'new.jar']);

  expected.hashes.sha1 = '0'.repeat(40);
  responses.set('new.jar', 'valid bytes');
  const badSha1 = await archive(directory, 'bad-hash', [expected]);
  await expect(pack.apply(instance, game, badSha1, (await pack.inspect(badSha1)).digest)).rejects.toThrow('SHA-1');

  const cached = resource('mods/keep.jar', original);
  cached.hashes.sha1 = '0'.repeat(40);
  const badCachedSha1 = await archive(directory, 'bad-cached-hash', [cached]);
  await expect(pack.apply(instance, game, badCachedSha1, (await pack.inspect(badCachedSha1)).digest)).rejects.toThrow(
    'could not be verified',
  );

  const conflict = await archive(directory, 'conflict', [], {
    'overrides/resourcepacks/Pack/pack.mcmeta': 'new resource-pack metadata',
  });
  await put(game, 'resourcepacks/Pack/pack.mcmeta', 'user modified resource-pack metadata');
  await expect(pack.apply(instance, game, conflict, (await pack.inspect(conflict)).digest)).rejects.toThrow(
    'locally edited',
  );
  expect(await contents(game, 'resourcepacks/Pack/pack.mcmeta')).toBe('user modified resource-pack metadata');
  expect(await contents(game, 'mods/keep.jar')).toBe(original);
  expect(await fileInfo(join(game, 'mods/new.jar'))).toBeUndefined();
  expect(await pack.current(instance, game)).toEqual(preview.preview);
});

test('rejects traversal, Windows collisions, special files, and out-of-scope files at preview', async () => {
  const { directory, instance, game, pack, put } = await setup();
  const cases = [
    { source: await archive(directory, 'malicious', [resource('../outside.jar', original)]), error: 'portable' },
    {
      source: await archive(directory, 'remote', [
        { ...resource('mods/keep.jar', original), downloads: ['https://localhost:9000/'] },
      ]),
      error: 'approved',
    },
    {
      source: await archive(directory, 'windows', [resource('mods/A.jar', original), resource('mods/a.jar', original)]),
      error: 'conflicting paths',
    },
    {
      source: await archive(directory, 'component-collision', [], {
        'overrides/config/Folder/a.json': '{}',
        'client-overrides/config/folder/b.json': '{}',
      }),
      error: 'conflicting paths',
    },
    {
      source: await archive(directory, 'symlink', [], {
        'overrides/config/linked.json': { data: 'outside', mode: 0o120777 },
      }),
      error: 'special file',
    },
    {
      source: await archive(directory, 'world', [], { 'overrides/saves/Injected/level.dat': '{}' }),
      error: 'unsupported client path',
    },
    {
      source: await archive(directory, 'owned-mod', [resource('mods/Rezics-A.jar', original)]),
      error: 'unsupported client',
    },
    {
      source: await archive(directory, 'unsupported-loader', [], {}, { minecraft: '1.21.1', 'quilt-loader': '0.26.0' }),
      error: 'unsupported',
    },
  ];
  for (const { source, error } of cases) await expect(pack.inspect(source)).rejects.toThrow(error);

  const traversal = await archive(directory, 'zip-traversal', [], { 'overrides/config/file': 'test' });
  const zip = (await readFile(traversal))
    .toString('latin1')
    .replaceAll('overrides/config/file', 'overrides/config/../x');
  await writeFile(traversal, Buffer.from(zip, 'latin1'));
  await expect(pack.inspect(traversal)).rejects.toThrow('invalid relative path');

  const source = await archive(directory, 'valid', [], { 'overrides/config/pack.json': 'allowed settings' });
  const inspected = await pack.inspect(source);
  await mkdir(game, { recursive: true });
  const outside = join(directory, 'outside');
  await put(outside, 'pack.json', 'untouched file');
  await symlink(outside, join(game, 'config'), 'junction');
  await expect(pack.apply(instance, game, source, inspected.digest)).rejects.toThrow('linked');
  expect(await contents(outside, 'pack.json')).toBe('untouched file');
  expect(await pack.current(instance, game)).toBeNull();

  await rm(join(game, 'config'));
  await put(game, 'config/PACK.json', 'unmanaged case alias');
  await expect(pack.apply(instance, game, source, inspected.digest)).rejects.toThrow('conflicts');
  expect(await contents(game, 'config/PACK.json')).toBe('unmanaged case alias');
});

test('repairs the installed release without its archive and preserves live override edits', async () => {
  const { directory, instance, game, pack, put, responses, downloaded } = await setup();
  const source = await archive(directory, 'version', [resource('mods/keep.jar', original)], {
    'overrides/options.txt': 'pack options',
    'overrides/config/missing.json': 'original settings',
  });
  responses.set('keep.jar', original);
  const preview = await pack.inspect(source);
  await pack.apply(instance, game, source, preview.digest);
  const selection = preview.preview.selection;
  await put(game, 'mods/keep.jar', 'truncated');
  await put(game, 'options.txt', 'live options');
  await rm(join(game, 'config/missing.json'));
  expect(await pack.firstDamagedDownload(instance, game)).toBe('mods/keep.jar');

  const update = await archive(directory, 'another-version', [resource('mods/keep.jar', original)]);
  await expect(pack.apply(instance, game, update, (await pack.inspect(update)).digest)).rejects.toThrow(
    'Repair the installed pack',
  );
  await rm(source);
  responses.set('keep.jar', 'broken download');
  await expect(pack.repair(instance, game, selection)).rejects.toThrow('Could not verify');
  expect(await contents(game, 'mods/keep.jar')).toBe('truncated');
  expect(await contents(game, 'options.txt')).toBe('live options');
  expect(await fileInfo(join(game, 'config/missing.json'))).toBeUndefined();

  const receiving = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let sentFirstChunk = false;
  responses.set(
    'keep.jar',
    new Response(
      new ReadableStream(
        {
          pull(stream) {
            if (sentFirstChunk) return cancelled.promise;
            sentFirstChunk = true;
            stream.enqueue(Buffer.of(1));
            receiving.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  const stop = new AbortController();
  const repair = pack.repair(instance, game, selection, { signal: stop.signal });
  const result = repair.catch((error: unknown) => error);
  await receiving.promise;
  stop.abort(new Error('Cancelled repair'));
  expect(await result).toBe(stop.signal.reason);
  await cancelled.promise;
  expect(await contents(game, 'mods/keep.jar')).toBe('truncated');
  expect(await fileInfo(join(instance, 'modrinth-pack-staging'))).toBeUndefined();

  responses.set('keep.jar', original);
  expect(await pack.repair(instance, game, selection)).toBe(2);
  expect(await pack.firstDamagedDownload(instance, game)).toBeUndefined();
  expect(await contents(game, 'mods/keep.jar')).toBe(original);
  expect(await contents(game, 'options.txt')).toBe('live options');
  expect(await contents(game, 'config/missing.json')).toBe('original settings');
  expect(await pack.repair(instance, game, selection)).toBe(0);
  const exported = await pack.export(instance, game, join(directory, 'repaired.mrpack'));
  expect((await pack.inspect(exported)).preview).toEqual(preview.preview);
  expect(downloaded).toEqual(['keep.jar', 'keep.jar', 'keep.jar', 'keep.jar']);
});

test('rolls back an interrupted commit and retains a moved original until its path is free', async () => {
  const { directory, instance, game, pack, put } = await setup();
  const source = await archive(directory, 'before', [], {
    'overrides/config/pack.json': 'previous',
    'overrides/config/z.json': 'original settings',
  });
  const inspected = await pack.inspect(source);
  await pack.apply(instance, game, source, inspected.digest);

  const ledger = JSON.parse(await contents(instance, 'modrinth-pack.json')) as { transaction: string };
  const stage = join(instance, 'modrinth-pack-staging');
  const generation = randomUUID();
  const fingerprint = (value: string) => ({
    bytes: Buffer.byteLength(value),
    sha512: createHash('sha512').update(value).digest('hex'),
  });
  await put(join(stage, 'next'), 'config/pack.json', 'next version');
  await put(join(stage, 'next'), 'config/new.json', 'new file');
  await mkdir(join(stage, 'previous/config'), { recursive: true });
  await writeJson(join(stage, 'journal.json'), {
    transaction: generation,
    previousTransaction: ledger.transaction,
    changes: [
      { path: 'config/pack.json', previous: fingerprint('previous'), next: fingerprint('next version') },
      { path: 'config/new.json', previous: null, next: fingerprint('new file') },
      { path: 'config/z.json', previous: fingerprint('original settings'), next: null },
    ],
  } satisfies PackJournal);
  await rename(join(game, 'config/pack.json'), join(stage, 'previous/config/pack.json'));
  await link(join(stage, 'next/config/pack.json'), join(game, 'config/pack.json'));
  await link(join(stage, 'next/config/new.json'), join(game, 'config/new.json'));
  await rename(join(game, 'config/z.json'), join(stage, 'previous/config/z.json'));
  await put(game, 'config/z.json', 'player replacement');
  await put(join(instance, 'modrinth-pack-content', generation), 'config/pack.json', 'incomplete update');
  await expect(new ModrinthPacks().recover(instance, game)).rejects.toThrow('recovery path (config/z.json)');
  expect(await contents(game, 'config/pack.json')).toBe('previous');
  expect(await fileInfo(join(game, 'config/new.json'))).toBeUndefined();
  expect(await contents(game, 'config/z.json')).toBe('player replacement');
  expect(await contents(stage, 'previous/config/z.json')).toBe('original settings');

  await rm(join(game, 'config/z.json'));
  await new ModrinthPacks().recover(instance, game);
  await pack.recover(instance, game);
  expect(await contents(game, 'config/z.json')).toBe('original settings');
  expect(await fileInfo(join(instance, 'modrinth-pack-content', generation))).toBeUndefined();
  expect(await fileInfo(stage)).toBeUndefined();
  expect(await pack.current(instance, game)).toEqual(inspected.preview);
  const exported = await pack.export(instance, game, join(directory, 'recovered.mrpack'));
  expect((await pack.inspect(exported)).preview).toEqual(inspected.preview);
});

test('cleans a stopped export without touching the final archive or neighboring files', async () => {
  const { directory, instance, game, pack, put } = await setup();
  const removable = join(await realpath(directory), 'removable');
  await mkdir(removable);
  const id = randomUUID();
  const journals = join(instance, 'modrinth-pack-exports');
  const journal = join(journals, `${id}.json`);
  const scratch = join(removable, `.modrinth-export-${id}`);
  await writeJson(journal, { folder: removable, id });
  await put(removable, 'final.mrpack', 'existing complete export');
  await put(scratch, 'pack.mrpack', 'interrupted export');
  await put(scratch, 'user-file.txt', 'another file');
  const detached = join(directory, 'detached');
  await rename(removable, detached);
  await expect(pack.current(instance, game)).resolves.toBeNull();
  expect(await fileInfo(journal)).toBeDefined();
  await rename(detached, removable);

  await pack.recover(instance, game);
  expect(await fileInfo(journals)).toBeUndefined();
  expect(await fileInfo(join(scratch, 'pack.mrpack'))).toBeUndefined();
  expect(await contents(scratch, 'user-file.txt')).toBe('another file');
  expect(await contents(removable, 'final.mrpack')).toBe('existing complete export');
});

const node = Bun.which('node');
const suitableNode =
  node &&
  Bun.spawnSync([node, '-e', "process.exit(typeof require('node:zlib').crc32 !== 'function' ? 1 : 0)"], {
    timeout: 3000,
  }).exitCode === 0;

test.skipIf(!suitableNode)(
  'streams multi-MiB deflated and stored entries in the bundled Node host',
  async () => {
    const { directory } = await setup();
    const program = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./modrinth-pack-node-fixture.ts', import.meta.url))],
      outdir: directory,
      naming: '[name].mjs',
      target: 'node',
    });
    const child = Bun.spawn([node!, program.outputs[0]!.path, directory], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`Bundled Node pack fixture exited ${status}\n${errors}`);
  },
  20_000,
);
