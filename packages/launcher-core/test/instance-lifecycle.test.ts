import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { InstalledStore } from '../src/installed.ts';
import { Instances, type MinecraftInstance } from '../src/instances.ts';
import { ModrinthPacks } from '../src/plugins/modrinth-pack.ts';
import { fileInfo, writeJson } from '../src/storage.ts';

const temporary = fileURLToPath(new URL('../.temp/', import.meta.url));
const directories: string[] = [];
const selection = { version: '1.21.1', loader: 'fabric', fabricVersion: '0.16.14' } as const;
const world = 'saves/Original world/level.dat';

async function fixture() {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'instance-lifecycle-'));
  directories.push(directory);
  const data = join(directory, 'launcher-data');
  return { directory, data, instances: new Instances(data) };
}

async function put(base: string, path: string, text: string) {
  const target = join(base, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

const contents = (base: string, path: string) => readFile(join(base, path), 'utf8');

async function packFixture(directory: string) {
  const path = join(directory, 'fixture.mrpack');
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Portable fixture',
        versionId: '1',
        files: [],
        dependencies: { minecraft: selection.version, 'fabric-loader': selection.fabricVersion },
      }),
    ),
    'modrinth.index.json',
  );
  zip.addBuffer(Buffer.from('pack override'), 'overrides/config/pack.ini');
  const output = pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx' }));
  zip.end();
  await output;
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('preserves an instance destination created while a version copy was staging', async () => {
  const { data, instances } = await fixture();
  const source = await instances.minecraft({ name: 'Original', loader: selection.loader }, selection);
  const original = join(instances.gamePath(source.id), world);
  await put(instances.gamePath(source.id), world, 'source world bytes');
  const copyId = `game-${randomUUID()}`;
  const destination = instances.directory(copyId);
  const copy: MinecraftInstance = {
    id: copyId,
    kind: 'minecraft',
    name: 'Upgraded copy',
    minecraft: { loader: 'vanilla', version: '26.3', prepared: true },
    installation: { versionId: '26.3', javaMajor: 25 },
  };
  const signal = new AbortController().signal;
  let occupied: number | undefined;
  const attempt = instances.copyMinecraftUpgrade(source.id, copy, signal, async (publish) => {
    await mkdir(destination);
    occupied = (await stat(destination)).ino;
    await publish();
  });
  await expect(attempt).rejects.toThrow('An instance folder already uses this ID.');
  if (occupied === undefined) throw new Error('The competing destination was never created.');
  expect((await stat(destination)).ino).toBe(occupied);
  expect(await readdir(destination)).toEqual([]);
  expect(await readdir(join(data, 'instances', '.duplicate-staging'))).toEqual([]);
  expect(await readFile(original, 'utf8')).toBe('source world bytes');
  expect((await instances.list()).map(({ id }) => id)).toEqual([source.id]);
  const retry = { ...copy, id: `game-${randomUUID()}` };
  await instances.copyMinecraftUpgrade(source.id, retry, signal, (publish) => publish());
  expect(await contents(instances.gamePath(retry.id), world)).toBe('source world bytes');
});

test('leaves a late Modrinth import destination in place and clears only its staging', async () => {
  const { data, instances } = await fixture();
  const folders = join(data, 'instances');
  const stage = join(folders, '.modrinth-import');
  const input = { name: 'Pack import', loader: selection.loader };
  const signal = new AbortController().signal;
  const keep = await put(folders, 'keep.txt', 'unrelated file');
  const populate = (directory: string) => put(directory, 'game/config/options.ini', 'packed settings');
  let occupied: { path: string; inode: number } | undefined;
  await expect(
    instances.publishMinecraftImport(input, selection, populate, undefined, {
      signal,
      beginCommit() {
        const { id } = JSON.parse(readFileSync(join(stage, 'instance.json'), 'utf8')) as MinecraftInstance;
        const path = instances.directory(id);
        mkdirSync(path);
        occupied = { path, inode: statSync(path).ino };
      },
    }),
  ).rejects.toThrow('An instance folder already uses this ID.');
  if (!occupied) throw new Error('The competing destination was never created.');
  expect((await stat(occupied.path)).ino).toBe(occupied.inode);
  expect(await readdir(occupied.path)).toEqual([]);
  expect(await fileInfo(stage)).toBeUndefined();
  expect(await readFile(keep, 'utf8')).toBe('unrelated file');
  const retry = await instances.publishMinecraftImport(input, selection, populate);
  expect(await contents(instances.gamePath(retry.id), 'config/options.ini')).toBe('packed settings');
});

test('duplicates independent Minecraft settings, modpack and mods, and selected live worlds', async () => {
  const { directory, data, instances } = await fixture();
  const original = await instances.minecraft({ name: 'Original', loader: selection.loader }, selection);
  const home = instances.directory(original.id);
  const game = instances.gamePath(original.id);
  const settings = { java: { kind: 'custom', executable: join(directory, 'java.exe') }, maxMemoryMiB: 4096 } as const;
  const installation = { versionId: '1.21.1-fabric-0.16.14', javaRuntime: 'java-runtime-delta', javaMajor: 21 };
  await instances.write({
    id: original.id,
    name: original.name,
    kind: 'minecraft',
    minecraft: { ...selection, settings, prepared: true },
    installation,
  });
  await put(data, 'minecraft-resources/shared-verified.txt', 'installed resource shared by instances');
  const packs = new ModrinthPacks();
  const source = await packFixture(directory);
  const preview = await packs.inspect(source);
  await packs.apply(home, game, source, preview.digest);
  const mods = new InstalledStore(join(home, 'installed-mods'), join(game, 'mods'));
  await mods.edit(async (_, staging) => {
    const artifact = await put(staging, 'fixture.jar', 'installed mod data');
    return {
      next: [
        {
          id: 'example',
          releaseId: 'one',
          title: 'Example',
          version: '1',
          source: 'local',
          enabled: true,
          requires: [],
          conflicts: [],
        },
      ],
      artifacts: new Map([['example', artifact]]),
    };
  });

  await put(game, world, 'world contents');
  await put(game, 'saves/Original world/session.lock', 'stale lock');
  await put(game, 'saves/.rezics-restore-recovery/partial', 'staged restore');
  await put(game, 'logs/latest.log', 'diagnostics');
  await put(game, 'crash-reports/latest.txt', 'diagnostics');
  await put(home, 'last-launch.json', 'diagnostics');
  await put(home, 'minecraft-preparation.json', 'previous install job');
  await put(home, 'snapshots/snapshot-abc/snapshot.json', 'backup history');
  await put(home, 'installed-mods/install-staging/stale', 'unpublished mod');
  await put(home, 'modrinth-pack-staging/stale', 'unpublished pack');
  await put(home, 'modrinth-pack-exports/stale', 'pending export');
  await put(home, 'modrinth-pack-content/obsolete/unrelated', 'old generation');
  await put(game, 'config/options.ini', 'user settings');
  await put(game, 'config/hard-link-source.ini', 'hard links copied as ordinary files');
  await link(join(game, 'config/hard-link-source.ini'), join(game, 'config/ordinary-copy.ini'));
  const outside = await put(directory, 'outside/private.ini', 'external data');
  await symlink(dirname(outside), join(game, 'config/external'), 'junction');

  const trimmed = await instances.renameMinecraft(original.id, '  Main Minecraft  ');
  expect(trimmed).toMatchObject({
    id: original.id,
    name: 'Main Minecraft',
    minecraft: { ...selection, prepared: true, settings },
  });
  const fresh = await instances.duplicateMinecraft(original.id, 'No worlds', false);
  const cloned = await instances.duplicateMinecraft(original.id, 'World copy', true);
  expect(new Set([original.id, fresh.id, cloned.id]).size).toBe(3);
  for (const copy of [fresh, cloned]) {
    const copyHome = instances.directory(copy.id);
    const copyGame = instances.gamePath(copy.id);
    expect(await instances.find(copy.id)).toMatchObject({
      minecraft: { ...selection, settings, prepared: true },
      installation,
    });
    expect(await contents(copyGame, 'config/options.ini')).toBe('user settings');
    expect(await contents(copyGame, 'config/pack.ini')).toBe('pack override');
    expect(await fileInfo(join(copyGame, 'config/external'))).toBeUndefined();
    expect(await fileInfo(join(copyHome, 'minecraft-resources'))).toBeUndefined();
    expect(await packs.current(copyHome, copyGame)).toEqual(preview.preview);
    expect(await new InstalledStore(join(copyHome, 'installed-mods'), join(copyGame, 'mods')).list()).toHaveLength(1);
    const modNames = await readdir(join(copyGame, 'mods'));
    expect(await contents(copyGame, join('mods', modNames[0]!))).toBe('installed mod data');
    for (const omitted of [
      'game/logs',
      'game/crash-reports',
      'last-launch.json',
      'minecraft-preparation.json',
      'snapshots',
      'installed-mods/install-staging',
      'modrinth-pack-staging',
      'modrinth-pack-exports',
      'modrinth-pack-content/obsolete',
    ])
      expect(await fileInfo(join(copyHome, omitted))).toBeUndefined();
  }
  expect(await fileInfo(join(instances.gamePath(fresh.id), 'saves'))).toBeUndefined();
  const clonedGame = instances.gamePath(cloned.id);
  expect(await contents(clonedGame, world)).toBe('world contents');
  const clonedPack = await packs.export(instances.directory(cloned.id), clonedGame, join(directory, 'cloned.mrpack'));
  expect((await packs.inspect(clonedPack)).preview).toEqual(preview.preview);
  expect(await fileInfo(join(clonedGame, 'saves/Original world/session.lock'))).toBeUndefined();
  expect(await fileInfo(join(clonedGame, 'saves/.rezics-restore-recovery'))).toBeUndefined();
  await put(clonedGame, world, 'separate world');
  await put(clonedGame, 'config/ordinary-copy.ini', 'separate file');
  expect(await contents(game, world)).toBe('world contents');
  expect(await contents(game, 'config/ordinary-copy.ini')).toBe('hard links copied as ordinary files');
  expect(await contents(directory, 'outside/private.ini')).toBe('external data');
});

test('archives the whole managed instance, restores the same identity, and only permanently deletes archived Minecraft', async () => {
  const { directory, data, instances } = await fixture();
  const minecraft = await instances.minecraft({ name: 'Primary', loader: selection.loader }, selection);
  const other = await instances.minecraft({ name: 'Sibling', loader: selection.loader }, selection);
  const external = await put(directory, 'external/vn.exe', 'imported external program');
  const local = await instances.local({
    kind: 'visual-novel',
    name: 'Imported',
    executable: external,
    workingDirectory: dirname(external),
  });
  const game = instances.gamePath(minecraft.id);
  await put(game, world, 'world contents');
  await put(instances.gamePath(other.id), world, 'sibling world');
  await put(instances.directory(minecraft.id), 'snapshots/checkpoint/snapshot.json', 'saved history');
  await symlink(dirname(external), join(game, 'outside'), 'junction');

  await expect(instances.renameMinecraft(local.id, 'Wrong kind')).rejects.toThrow('Minecraft');
  await expect(instances.duplicateMinecraft(local.id, 'Wrong kind', true)).rejects.toThrow('Minecraft');
  await expect(instances.archiveMinecraft(local.id)).rejects.toThrow('Minecraft');
  await expect(instances.deleteArchivedMinecraft(minecraft.id, 'a'.repeat(64))).rejects.toThrow('archived');
  await expect(instances.restoreArchivedMinecraft('../outside')).rejects.toThrow('Invalid identifier');

  await instances.archiveMinecraft(minecraft.id);
  const archivedPath = join(data, 'instances', '.archive', minecraft.id, 'instance.json');
  // An existing archive from before revisions were stored can still be reviewed.
  await writeJson(archivedPath, minecraft);
  const restarted = new Instances(data);
  expect((await restarted.list()).map(({ id }) => id)).toEqual([local.id, other.id]);
  const [originalArchive] = await restarted.listArchivedMinecraft();
  expect(originalArchive).toMatchObject(minecraft);
  expect(originalArchive?.revision).toMatch(/^[a-f0-9]{64}$/u);
  await expect(restarted.find(minecraft.id)).rejects.toThrow('does not exist');
  const active = restarted.directory(minecraft.id);
  await mkdir(active);
  await expect(restarted.restoreArchivedMinecraft(minecraft.id)).rejects.toThrow('already uses this ID');
  expect(await restarted.listArchivedMinecraft()).toEqual([originalArchive!]);
  await rm(active, { recursive: true });
  expect(await restarted.restoreArchivedMinecraft(minecraft.id)).toEqual(minecraft);
  expect(await contents(game, world)).toBe('world contents');
  expect(await contents(active, 'snapshots/checkpoint/snapshot.json')).toBe('saved history');

  await restarted.archiveMinecraft(minecraft.id);
  const [secondArchive] = await restarted.listArchivedMinecraft();
  await expect(restarted.deleteArchivedMinecraft(minecraft.id, originalArchive!.revision)).rejects.toThrow(
    'archive entry changed',
  );
  expect(await restarted.listArchivedMinecraft()).toEqual([secondArchive!]);
  await restarted.deleteArchivedMinecraft(minecraft.id, secondArchive!.revision);
  expect(await restarted.listArchivedMinecraft()).toEqual([]);
  expect((await restarted.list()).map(({ id }) => id)).toEqual([local.id, other.id]);
  expect(await contents(restarted.gamePath(other.id), world)).toBe('sibling world');
  expect(await readFile(external, 'utf8')).toBe('imported external program');
});

test('reclaims only controlled interrupted stages and hides a failed duplication', async () => {
  const { directory, data, instances } = await fixture();
  const original = await instances.minecraft({ name: 'Original', loader: selection.loader }, selection);
  const instancesRoot = dirname(instances.directory(original.id));
  const staging = join(instancesRoot, '.duplicate-staging');
  const deletion = join(instancesRoot, '.archive-deleting');
  const interruptedCopy = `game-${randomUUID()}`;
  const interruptedDeletion = `game-${randomUUID()}`;
  await put(staging, join(interruptedCopy, 'instance.json'), 'not published');
  await put(deletion, join(interruptedDeletion, 'game/save'), 'awaiting reclaim');
  await put(staging, 'unknown/keep.txt', 'unknown folder');
  const outside = await put(directory, 'outside/keep.txt', 'external content');
  const linked = `game-${randomUUID()}`;
  await symlink(dirname(outside), join(deletion, linked), 'junction');

  const restarted = new Instances(data);
  expect(await restarted.list()).toEqual([original]);
  expect(await fileInfo(join(staging, interruptedCopy))).toBeUndefined();
  expect(await fileInfo(join(deletion, interruptedDeletion))).toBeUndefined();
  expect(await contents(staging, 'unknown/keep.txt')).toBe('unknown folder');
  expect((await fileInfo(join(deletion, linked)))?.isSymbolicLink()).toBeTrue();
  expect(await readFile(outside, 'utf8')).toBe('external content');

  await put(restarted.gamePath(original.id), world, 'source game data');
  await writeJson(join(restarted.directory(original.id), 'modrinth-pack.json'), { transaction: '../outside' });
  await expect(restarted.duplicateMinecraft(original.id, 'Fails', true)).rejects.toThrow('could not be copied');
  expect(await restarted.list()).toEqual([original]);
  expect(await readdir(staging)).toEqual(['unknown']);
  expect(await contents(restarted.gamePath(original.id), world)).toBe('source game data');
  expect(((await restarted.find(original.id)) as MinecraftInstance).minecraft).toMatchObject(selection);
});
