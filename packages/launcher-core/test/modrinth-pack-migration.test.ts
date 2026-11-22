import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { createLauncher } from '../src/index.ts';
import { Instances } from '../src/instances.ts';
import { packIndexName } from '../src/plugins/modrinth-pack-format.ts';
import { fileInfo, writeJson } from '../src/storage.ts';
import { levelSavedIn } from './fixtures/minecraft-level.ts';

const temporary = fileURLToPath(new URL('../.temp/', import.meta.url));
const cleanup: string[] = [];
const worldId = 'My world 村';
const secondWorldId = 'Other World';
const oldSelection = { version: '1.21.1', loader: 'fabric', fabricVersion: '0.16.14' } as const;
const newSelection = { version: '1.20.1', loader: 'vanilla' } as const;
const remote = new URL('https://cdn.modrinth.com/data/fixture/versions/migration/world-helper.jar');
const resourceBytes = Buffer.from('verified fixture bytes');

async function put(base: string, path: string, bytes: string) {
  const target = join(base, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

function packIndex(name: string, dependencies: Record<string, string>, needsDownload: boolean) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1',
    name,
    dependencies,
    files: needsDownload
      ? [
          {
            path: 'mods/world-helper.jar',
            downloads: [remote.href],
            hashes: {
              sha1: createHash('sha1').update(resourceBytes).digest('hex'),
              sha512: createHash('sha512').update(resourceBytes).digest('hex'),
            },
            fileSize: resourceBytes.length,
          },
        ]
      : [],
  };
}

async function archive(directory: string, file: string, index: ReturnType<typeof packIndex>) {
  const path = join(directory, file);
  const pack = new ZipFile();
  pack.addBuffer(Buffer.from(JSON.stringify(index)), packIndexName);
  pack.addBuffer(Buffer.from(index.name), 'overrides/config/options.ini');
  const done = pipeline(pack.outputStream, createWriteStream(path, { flags: 'wx' }));
  pack.end();
  await done;
  return path;
}

async function setup() {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'modrinth-pack-migration-'));
  cleanup.push(directory);
  const data = join(directory, 'launcher-data');
  const instances = new Instances(data);
  let download = () => Promise.resolve(new Response(resourceBytes));
  const fetcher = (async (input) => {
    const url = new URL(String(input));
    if (url.href === remote.href) return download();
    if (url.origin === 'https://piston-meta.mojang.com' && url.pathname === '/mc/game/version_manifest_v2.json') {
      return Response.json({
        versions: [newSelection.version, oldSelection.version].map((id) => ({
          id,
          type: 'release',
          url: `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`,
        })),
      });
    }
    if (url.href === `https://piston-meta.mojang.com/v1/packages/fixture/${newSelection.version}.json`) {
      return Response.json({
        id: newSelection.version,
        mainClass: 'fixture.Game',
        javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
      });
    }
    throw new Error('Unexpected fixture address');
  }) as typeof fetch;
  const launcher = createLauncher({
    dataDir: data,
    catalogUrl: 'https://kernel.example.invalid',
    webUrl: 'https://rezics.com',
    launcherVersion: 'fixture',
    openExternal: async () => {},
    fetch: fetcher,
  });
  const source = await launcher.createMinecraft({ name: 'Original', ...oldSelection });
  const home = instances.directory(source.id);
  const game = instances.gamePath(source.id);
  const snapshots = join(home, 'snapshots');
  await put(game, `saves/${worldId}/level.dat`, 'selected-world');
  await put(game, `saves/${worldId}/region/r.0.0.mca`, 'selected-region');
  await put(game, `saves/${worldId}/session.lock`, 'stale file lock');
  await put(game, `saves/${secondWorldId}/level.dat`, 'unselected-world');
  const localPack = await archive(
    directory,
    'source.mrpack',
    packIndex(
      'Original pack',
      {
        minecraft: oldSelection.version,
        'fabric-loader': oldSelection.fabricVersion,
      },
      false,
    ),
  );
  const original = await launcher.inspectModrinthPack(localPack);
  await launcher.importModrinthPack(localPack, original.digest, original.preview, source.id);
  await put(game, 'mods/independent.jar', 'original local mod');
  await writeJson(join(home, 'installed-mods', 'installed.json'), { packages: [], transaction: 'source-mods' });
  await put(snapshots, 'checkpoint/backup.txt', 'original backup');
  const sourceRecord = await instances.find(source.id);
  if (sourceRecord.kind !== 'minecraft') throw new Error('Expected a Minecraft fixture');
  await instances.write({
    ...sourceRecord,
    installation: { versionId: 'source-fixture', javaMajor: 21 },
    minecraft: {
      ...sourceRecord.minecraft,
      prepared: true,
      settings: {
        java: { kind: 'custom', executable: join(directory, 'java.exe') },
        maxMemoryMiB: 4096,
        accountId: 'saved-profile',
      },
    },
  });
  const next = await archive(
    directory,
    'migration.mrpack',
    packIndex('New release', { minecraft: newSelection.version }, true),
  );
  const incoming = await launcher.inspectModrinthPack(next);
  const staging = join(dirname(home), '.modrinth-import');
  return {
    directory,
    instances,
    launcher,
    source,
    game,
    home,
    original,
    next,
    incoming,
    staging,
    setDownload(value: typeof download) {
      download = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test.skipIf(process.platform === 'win32')('checks the chosen Java before publishing a new pack instance', async () => {
  const { directory, launcher, instances, source, next, incoming, staging, setDownload } = await setup();
  async function runtime(major: number) {
    const bin = join(directory, `jdk-${major}`, 'bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'java');
    await writeFile(
      executable,
      `#!/bin/sh\nprintf 'java.version = ${major}.0.1\\nos.arch = ${process.arch}\\n' >&2\n`,
      { mode: 0o755 },
    );
    return { kind: 'custom', executable: await realpath(executable) } as const;
  }
  const wrong = await runtime(21);
  const right = await runtime(17);
  const initial = await instances.find(source.id);
  let downloads = 0;
  setDownload(async () => {
    downloads++;
    return new Response(resourceBytes);
  });

  await expect(
    launcher.importModrinthPack(next, incoming.digest, incoming.preview, undefined, undefined, wrong),
  ).rejects.toThrow('requires Java 17');
  await expect(
    launcher.migrateModrinthPack(
      next,
      incoming.digest,
      incoming.preview,
      source.id,
      [worldId],
      undefined,
      undefined,
      wrong,
    ),
  ).rejects.toThrow('requires Java 17');
  await expect(
    launcher.importModrinthPack(next, incoming.digest, incoming.preview, source.id, undefined, right),
  ).rejects.toThrow('Choose a separate instance');
  expect(downloads).toBe(0);
  expect(await launcher.listInstances()).toHaveLength(1);
  expect(await fileInfo(staging)).toBeUndefined();

  const imported = await launcher.importModrinthPack(
    next,
    incoming.digest,
    incoming.preview,
    undefined,
    undefined,
    right,
  );
  expect(await instances.find(imported.id)).toMatchObject({
    minecraft: { ...newSelection, prepared: false, settings: { java: right } },
  });
  const migrated = await launcher.migrateModrinthPack(
    next,
    incoming.digest,
    incoming.preview,
    source.id,
    [worldId],
    undefined,
    undefined,
    right,
  );
  expect(await instances.find(migrated.id)).toMatchObject({
    minecraft: { settings: { java: right, maxMemoryMiB: 4096, accountId: 'saved-profile' } },
  });
  expect(await launcher.listMinecraftWorlds(migrated.id)).toEqual([{ id: worldId, name: worldId }]);
  expect(await instances.find(source.id)).toEqual(initial);
  expect(await fileInfo(staging)).toBeUndefined();
});

test('publishes a new exact-lane modpack with only selected independent worlds', async () => {
  const { launcher, instances, source, game, home, original, next, incoming, staging } = await setup();
  await expect(launcher.importModrinthPack(next, incoming.digest, incoming.preview, source.id)).rejects.toThrow(
    'exact Minecraft',
  );
  const ledgerBefore = await readFile(join(home, 'modrinth-pack.json'), 'utf8');
  const persistedSource = await instances.find(source.id);
  const migrated = await launcher.migrateModrinthPack(next, incoming.digest, incoming.preview, source.id, [worldId]);
  expect(migrated.id).not.toBe(source.id);
  expect(migrated).toMatchObject({
    name: 'New release',
    minecraft: {
      ...newSelection,
      prepared: false,
      settings: { java: { kind: 'managed' }, maxMemoryMiB: 4096, accountId: 'saved-profile' },
    },
  });
  expect(await instances.find(migrated.id)).not.toHaveProperty('installation');

  const resultHome = instances.directory(migrated.id);
  const resultGame = instances.gamePath(migrated.id);
  expect(await launcher.listMinecraftWorlds(migrated.id)).toEqual([{ id: worldId, name: worldId }]);
  expect(await readFile(join(resultGame, 'config/options.ini'), 'utf8')).toBe('New release');
  expect(await readFile(join(resultGame, 'mods/world-helper.jar'), 'utf8')).toBe('verified fixture bytes');
  expect(await readFile(join(resultGame, 'saves', worldId, 'level.dat'), 'utf8')).toBe('selected-world');
  expect(await readFile(join(resultGame, 'saves', worldId, 'region/r.0.0.mca'), 'utf8')).toBe('selected-region');
  expect(await fileInfo(join(resultGame, 'saves', worldId, 'session.lock'))).toBeUndefined();
  expect(await fileInfo(join(resultGame, 'saves', secondWorldId))).toBeUndefined();
  expect(await fileInfo(join(resultGame, 'mods/independent.jar'))).toBeUndefined();
  expect(await fileInfo(join(resultHome, 'snapshots'))).toBeUndefined();
  expect(await fileInfo(join(resultHome, 'installed-mods'))).toBeUndefined();
  expect(await fileInfo(staging)).toBeUndefined();

  await put(resultGame, `saves/${worldId}/level.dat`, 'independent-world');
  expect(await readFile(join(game, 'saves', worldId, 'level.dat'), 'utf8')).toBe('selected-world');
  expect(await readFile(join(game, 'saves', secondWorldId, 'level.dat'), 'utf8')).toBe('unselected-world');
  expect(await readFile(join(game, 'mods/independent.jar'), 'utf8')).toBe('original local mod');
  expect(await readFile(join(home, 'modrinth-pack.json'), 'utf8')).toBe(ledgerBefore);
  expect(await launcher.currentModrinthPack(source.id)).toEqual(original.preview);
  expect(await instances.find(source.id)).toEqual(persistedSource);
  expect(await readFile(join(home, 'snapshots/checkpoint/backup.txt'), 'utf8')).toBe('original backup');
});

test('refuses invalid world selections, unsafe trees, changed archives, forged previews and denied downloads', async () => {
  const { directory, launcher, source, game, next, incoming, staging, setDownload } = await setup();
  const migrate = (ids: string[], digest = incoming.digest, preview = incoming.preview) =>
    launcher.migrateModrinthPack(next, digest, preview, source.id, ids);
  await expect(migrate([])).rejects.toThrow('1 and 128');
  await expect(migrate(Array.from({ length: 129 }, (_, index) => `world-${index}`))).rejects.toThrow('1 and 128');
  await expect(migrate(['../outside'])).rejects.toThrow('valid Minecraft world');
  await expect(migrate(['CON.txt'])).rejects.toThrow('valid Minecraft world');
  await expect(migrate([worldId, worldId.toUpperCase()])).rejects.toThrow('conflicting names');
  await expect(migrate(['Café', 'Cafe\u0301'])).rejects.toThrow('conflicting names');
  await expect(migrate(['Deleted world'])).rejects.toThrow('unavailable or linked');
  const external = await put(directory, 'outside/level.dat', 'not a managed world');
  const linked = 'Linked World';
  await symlink(dirname(external), join(game, 'saves', linked), 'junction');
  await expect(migrate([linked])).rejects.toThrow('unavailable or linked');
  await expect(migrate([worldId], '0'.repeat(64))).rejects.toThrow('archive changed');
  await expect(migrate([worldId], incoming.digest, { ...incoming.preview, selection: oldSelection })).rejects.toThrow(
    'exact Minecraft',
  );

  setDownload(() => Promise.resolve(new Response('denied', { status: 403 })));
  await expect(migrate([worldId])).rejects.toThrow('403');
  setDownload(() => Promise.resolve(new Response(resourceBytes)));
  await symlink(dirname(external), join(game, 'saves', worldId, 'external'), 'junction');
  await expect(migrate([worldId])).rejects.toThrow('contains a link');

  expect((await launcher.listInstances()).map(({ id }) => id)).toEqual([source.id]);
  expect(await fileInfo(staging)).toBeUndefined();
  expect(await readFile(external, 'utf8')).toBe('not a managed world');
  expect(await readFile(join(game, 'saves', worldId, 'level.dat'), 'utf8')).toBe('selected-world');
});

test('checks the selected world release again after staging an independent pack', async () => {
  const { launcher, instances, source, game, next, incoming, staging, setDownload } = await setup();
  const chosen = [worldId];
  const level = join(game, 'saves', worldId, 'level.dat');
  const input = [next, incoming.digest, incoming.preview, source.id, chosen] as const;
  await writeFile(level, levelSavedIn('26.3'));
  const approval = await launcher.previewMinecraftWorldCopy(source.id, newSelection.version, chosen);
  expect(approval).toEqual({ worldVersion: '26.3', targetVersion: newSelection.version });
  expect(await launcher.previewMinecraftWorldCopy(source.id, newSelection.version, [secondWorldId])).toBeNull();
  await expect(launcher.migrateModrinthPack(...input)).rejects.toThrow('Review the world copy and confirm it');
  expect(await fileInfo(staging)).toBeUndefined();

  const newLevel = levelSavedIn('26.3.1');
  setDownload(async () => {
    await writeFile(level, newLevel);
    return new Response(resourceBytes);
  });
  await expect(launcher.migrateModrinthPack(...input, undefined, approval!)).rejects.toThrow('Review the world copy');
  expect(await fileInfo(staging)).toBeUndefined();
  expect((await launcher.listInstances()).map(({ id }) => id)).toEqual([source.id]);

  setDownload(() => Promise.resolve(new Response(resourceBytes)));
  const fresh = await launcher.previewMinecraftWorldCopy(source.id, newSelection.version, chosen);
  expect(fresh?.worldVersion).toBe('26.3.1');
  const copy = await launcher.migrateModrinthPack(...input, undefined, fresh!);
  expect(await readFile(join(instances.gamePath(copy.id), 'saves', worldId, 'level.dat'))).toEqual(newLevel);
  expect(await launcher.listMinecraftWorlds(copy.id)).toEqual([{ id: worldId, name: worldId }]);
  expect(await readFile(level)).toEqual(newLevel);
  expect(await readFile(join(game, 'saves', secondWorldId, 'level.dat'), 'utf8')).toBe('unselected-world');
});

test('cancels an unpublished migration and retries the selected worlds', async () => {
  const { launcher, instances, source, game, next, incoming, staging, setDownload } = await setup();
  const receiving = Promise.withResolvers<void>();
  setDownload(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(Buffer.of(1));
            receiving.resolve();
          },
        }),
      ),
  );
  const controller = new AbortController();
  let committed = false;
  const failed = launcher
    .migrateModrinthPack(next, incoming.digest, incoming.preview, source.id, [worldId], {
      signal: controller.signal,
      beginCommit() {
        committed = true;
      },
    })
    .catch((error: unknown) => error);
  await receiving.promise;
  controller.abort(new Error('Cancel the staged world migration.'));
  expect(await failed).toBe(controller.signal.reason);
  expect(committed).toBe(false);
  expect(await fileInfo(staging)).toBeUndefined();
  expect((await launcher.listInstances()).map(({ id }) => id)).toEqual([source.id]);
  expect(await readFile(join(game, 'saves', worldId, 'level.dat'), 'utf8')).toBe('selected-world');
  setDownload(async () => new Response(resourceBytes));
  const result = await launcher.migrateModrinthPack(next, incoming.digest, incoming.preview, source.id, [worldId]);
  expect((await launcher.listMinecraftWorlds(result.id)).map(({ id }) => id)).toEqual([worldId]);
  expect(await readFile(join(instances.gamePath(result.id), 'saves', worldId, 'level.dat'), 'utf8')).toBe(
    'selected-world',
  );
});

test('keeps a downloading migration invisible and rejects a selected world replaced before the copy', async () => {
  const { launcher, instances, source, game, next, incoming, staging, setDownload } = await setup();
  const unrelated = await launcher.createMinecraft({ name: 'Other instance', ...oldSelection });
  await put(instances.gamePath(unrelated.id), 'saves/Unrelated/level.dat', 'unrelated-world');
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Response>();
  setDownload(() => {
    started.resolve();
    return gate.promise;
  });
  const operation = launcher.migrateModrinthPack(next, incoming.digest, incoming.preview, source.id, [worldId]);
  const settle = operation.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    await Promise.race([
      started.promise,
      settle.then(({ error }) => {
        throw error ?? new Error('No download was held');
      }),
    ]);
    expect((await launcher.listInstances()).map(({ id }) => id).sort()).toEqual([source.id, unrelated.id].sort());
    expect(await launcher.listMinecraftWorlds(unrelated.id)).toEqual([{ id: 'Unrelated', name: 'Unrelated' }]);
    expect(await fileInfo(staging)).toBeDefined();
    await rename(join(game, 'saves', worldId), join(game, 'saves', 'Externally moved'));
    await put(game, `saves/${worldId}/level.dat`, 'replacement-world');
  } finally {
    gate.resolve(new Response(resourceBytes));
  }
  const result = await settle;
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain('world changed');
  expect((await launcher.listInstances()).map(({ id }) => id).sort()).toEqual([source.id, unrelated.id].sort());
  expect(await fileInfo(staging)).toBeUndefined();
  expect(await readFile(join(game, 'saves', worldId, 'level.dat'), 'utf8')).toBe('replacement-world');
  expect(await readFile(join(game, 'saves/Externally moved/level.dat'), 'utf8')).toBe('selected-world');
});

test.skipIf(process.platform === 'win32')('refuses to copy worlds used by an active overlapping game', async () => {
  const { directory, launcher, source, game, next, incoming, staging } = await setup();
  const script = join(directory, 'running-fixture');
  await writeFile(script, '#!/bin/sh\nexec sleep 20\n', { mode: 0o700 });
  const local = await launcher.importInstance({
    kind: 'local',
    name: 'Sharing the world directory',
    executable: script,
    workingDirectory: game,
  });
  const finished = Promise.withResolvers<void>();
  let notices = 0;
  const detach = launcher.subscribe((session) => {
    if (!session && ++notices === 2) finished.resolve();
  });
  const active = await launcher.launch(local.id);
  try {
    await expect(
      launcher.migrateModrinthPack(next, incoming.digest, incoming.preview, source.id, [worldId]),
    ).rejects.toThrow('Close the game');
    expect(await fileInfo(staging)).toBeUndefined();
    expect(await launcher.currentSession()).toMatchObject({ instanceId: local.id });
  } finally {
    try {
      await launcher.stopGame(active.sessionId);
      await Promise.race([
        finished.promise,
        setTimeout(4000, undefined, { ref: false }).then(() => {
          throw new Error('Fixture backup timed out');
        }),
      ]);
    } finally {
      detach();
    }
  }
});
