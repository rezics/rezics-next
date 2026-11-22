import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gzipSync } from 'node:zlib';
import { ZipFile } from 'yazl';
import { createLauncher, type LauncherOptions } from '../src/index.ts';
import { Instances } from '../src/instances.ts';
import { renameLinuxDirectory } from '../src/directory-move.ts';

const scratch = join(import.meta.dir, '../.temp');
const directories: string[] = [];
// Unnamed root compound, with a Data compound containing an integer DataVersion.
const level = gzipSync(
  Buffer.from([
    10, 0, 0, 10, 0, 4, 68, 97, 116, 97, 3, 0, 11, 68, 97, 116, 97, 86, 101, 114, 115, 105, 111, 110, 0, 0, 15, 222, 0,
    0,
  ]),
);

function versionedLevel(version: string, snapshot = 0) {
  const name = Buffer.from(version);
  const versionTag = Buffer.concat([
    Buffer.from('\x0a\x00\x07Version\x01\x00\x08Snapshot'),
    Buffer.from([snapshot]),
    Buffer.from('\x08\x00\x04Name\x00'),
    Buffer.from([name.length]),
    name,
    Buffer.from([0]),
  ]);
  // A similarly named tag under Player must have no effect on Data.Version.
  return gzipSync(
    Buffer.concat([
      Buffer.from('\x0a\x00\x00\x0a\x00\x04Data\x0a\x00\x06Player'),
      versionTag,
      Buffer.from([0]),
      versionTag,
      Buffer.from([0, 0]),
    ]),
  );
}

async function zip(values: Record<string, Buffer | string>) {
  const archive = new ZipFile();
  for (const [path, contents] of Object.entries(values))
    archive.addBuffer(Buffer.from(contents), path, { compress: false });
  archive.end();
  return buffer(archive.outputStream);
}

async function fixture(options: Pick<LauncherOptions, 'linuxRenameDirectory'> = {}) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'world-archive-'));
  directories.push(root);
  const launcher = createLauncher({
    dataDir: join(root, 'desktop'),
    catalogUrl: 'https://example.invalid',
    webUrl: 'https://example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
    ...options,
  });
  const left = await launcher.createMinecraft({ name: 'Left', loader: 'vanilla' });
  const right = await launcher.createMinecraft({ name: 'Right', loader: 'vanilla' });
  const pathFor = (id: string) => join(root, 'desktop', 'instances', id, 'game', 'saves');
  return { root, launcher, left, right, pathFor };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('previews and round-trips a wrapped world ZIP without replacing worlds or reusing runtime lock files', async () => {
  const { root, launcher, left, right, pathFor } = await fixture();
  const world = join(root, 'provider.zip');
  await writeFile(
    world,
    await zip({
      'Timeline/level.dat': level,
      'Timeline/region/r.0.0.mca': 'instance data',
      'Timeline/session.lock': 'foreign lock',
      '__MACOSX/._Timeline': 'wrapper metadata',
    }),
  );
  const { archive, digest } = await launcher.inspectMinecraftWorldArchive(world);
  expect(archive).toEqual({ name: 'Timeline', files: 2, bytes: level.length + 'instance data'.length });
  expect(await launcher.listMinecraftWorlds(left.id)).toEqual([]);
  expect(await launcher.importMinecraftWorldArchive(left.id, world, digest, archive.name)).toEqual({
    id: 'Timeline',
    name: 'Timeline',
  });
  await expect(launcher.importMinecraftWorldArchive(left.id, world, digest, 'timeline')).rejects.toThrow('already has');
  const directory = join(pathFor(left.id), 'Timeline');
  expect((await readFile(join(directory, 'level.dat'))).equals(level)).toBe(true);
  expect(await readdir(directory)).toEqual(['level.dat', 'region']);
  await writeFile(join(directory, 'session.lock'), 'current lock');

  const destination = join(root, 'Shared.zip');
  expect(await launcher.exportMinecraftWorldArchive(left.id, 'Timeline', destination)).toBe(destination);
  await expect(launcher.exportMinecraftWorldArchive(left.id, 'Timeline', destination)).rejects.toThrow('already');
  await expect(
    launcher.exportMinecraftWorldArchive(left.id, 'Timeline', join(directory, 'Archive.zip')),
  ).rejects.toThrow('outside');
  const exported = await launcher.inspectMinecraftWorldArchive(destination);
  expect(exported.archive.files).toBe(2);
  await launcher.importMinecraftWorldArchive(right.id, destination, exported.digest, exported.archive.name);
  expect(await readdir(join(pathFor(right.id), 'Shared'))).toEqual(['level.dat', 'region']);
  await writeFile(join(pathFor(right.id), 'Shared', 'region', 'r.0.0.mca'), 'independent bytes');
  expect(await readFile(join(directory, 'region', 'r.0.0.mca'), 'utf8')).toBe('instance data');
});

test('a cancelled world request leaves existing worlds and destinations available for retry', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const archive = join(root, 'world.zip');
  const source = join(root, 'world');
  await mkdir(source);
  await writeFile(join(source, 'level.dat'), level);
  await writeFile(archive, await zip({ 'level.dat': level }));
  const zipReview = await launcher.inspectMinecraftWorldArchive(archive);
  const folderReview = await launcher.inspectMinecraftWorldFolder(source);
  const instance = left.id;
  const cancellation = new Error('World transfer cancelled.');
  const signal = AbortSignal.abort(cancellation);

  await expect(launcher.inspectMinecraftWorldArchive(archive, instance, signal)).rejects.toThrow(cancellation);
  await expect(launcher.inspectMinecraftWorldFolder(source, instance, signal)).rejects.toThrow(cancellation);
  await expect(
    launcher.importMinecraftWorldArchive(instance, archive, zipReview.digest, 'ZIP', undefined, undefined, signal),
  ).rejects.toThrow(cancellation);
  await expect(
    launcher.importMinecraftWorldFolder(instance, source, folderReview.digest, 'Folder', undefined, undefined, signal),
  ).rejects.toThrow(cancellation);
  expect(await launcher.listMinecraftWorlds(instance)).toEqual([]);
  await launcher.importMinecraftWorldArchive(instance, archive, zipReview.digest, 'ZIP');
  const destination = join(root, 'copy.zip');
  await expect(launcher.exportMinecraftWorldArchive(instance, 'ZIP', destination, signal)).rejects.toThrow(
    cancellation,
  );
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(pathFor(instance), 'ZIP', 'level.dat'))).toEqual(level);
  expect(await launcher.exportMinecraftWorldArchive(instance, 'ZIP', destination)).toBe(destination);
});

test('suggests an available folder name for either source and keeps an explicit conflict fixed', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const name = 'État';
  const source = join(root, name);
  await mkdir(source);
  await writeFile(join(source, 'level.dat'), level);
  const archive = join(root, 'world.zip');
  await writeFile(archive, await zip({ [`${name}/level.dat`]: level }));
  const saves = pathFor(left.id);
  await mkdir(join(saves, 'E\u0301TAT'), { recursive: true });
  await writeFile(join(saves, 'E\u0301TAT', 'existing'), 'original');
  await writeFile(join(saves, `${name} (2)`), 'other file');

  const folderReview = await launcher.inspectMinecraftWorldFolder(source, left.id);
  const zipReview = await launcher.inspectMinecraftWorldArchive(archive, left.id);
  expect(folderReview.folder.name).toBe(`${name} (3)`);
  expect(zipReview.archive.name).toBe(`${name} (3)`);
  await expect(launcher.importMinecraftWorldFolder(left.id, source, folderReview.digest, name)).rejects.toThrow(
    'Choose another name.',
  );
  await launcher.importMinecraftWorldArchive(left.id, archive, zipReview.digest, zipReview.archive.name);
  expect((await launcher.inspectMinecraftWorldFolder(source, left.id)).folder.name).toBe(`${name} (4)`);
  expect(await readFile(join(saves, 'E\u0301TAT', 'existing'), 'utf8')).toBe('original');
  expect(await readFile(join(saves, `${name} (2)`), 'utf8')).toBe('other file');
  expect(await readFile(join(saves, `${name} (3)`, 'level.dat'))).toEqual(level);
});

test.skipIf(process.platform !== 'linux')(
  'preserves an empty destination created immediately before publication',
  async () => {
    let occupiedInode: number | undefined;
    const { root, launcher, left, pathFor } = await fixture({
      async linuxRenameDirectory(source, destination) {
        if (occupiedInode === undefined) {
          await mkdir(destination);
          occupiedInode = (await stat(destination)).ino;
        }
        return renameLinuxDirectory(source, destination);
      },
    });
    const source = join(root, 'world.zip');
    await writeFile(source, await zip({ 'level.dat': level }));
    const { digest } = await launcher.inspectMinecraftWorldArchive(source, left.id);
    await expect(launcher.importMinecraftWorldArchive(left.id, source, digest, 'World')).rejects.toThrow(
      'Choose another name.',
    );
    const target = join(pathFor(left.id), 'World');
    expect(await readdir(target)).toEqual([]);
    expect((await stat(target)).ino).toBe(occupiedInode!);
    const retry = await launcher.inspectMinecraftWorldArchive(source, left.id);
    expect(retry.archive.name).toBe('world (2)');
    await launcher.importMinecraftWorldArchive(left.id, source, retry.digest, retry.archive.name);
    expect(await readFile(join(pathFor(left.id), retry.archive.name, 'level.dat'))).toEqual(level);
  },
);

test('preserves an input ZIP in the staging folder and cleans only the staged world on another import', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const stage = join(root, 'desktop', 'instances', left.id, '.world-import-staging');
  await mkdir(join(stage, 'world'), { recursive: true });
  await writeFile(join(stage, 'world', 'partial'), 'left by an interrupted copy');
  const selected = join(stage, 'Personal.zip');
  const bytes = await zip({ 'level.dat': level });
  await writeFile(selected, bytes);
  const { digest } = await launcher.inspectMinecraftWorldArchive(selected);
  await expect(launcher.inspectMinecraftWorldArchive(selected, left.id)).rejects.toThrow('outside the import staging');
  await expect(launcher.importMinecraftWorldArchive(left.id, selected, digest, 'Selected')).rejects.toThrow(
    'outside the import staging',
  );
  expect(await readFile(selected)).toEqual(bytes);
  const external = join(root, 'external.zip');
  await writeFile(external, bytes);
  await launcher.importMinecraftWorldArchive(left.id, external, digest, 'Selected');
  expect(await readdir(stage)).toEqual(['Personal.zip']);
  expect(await readFile(selected)).toEqual(bytes);
  expect(await readFile(join(pathFor(left.id), 'Selected', 'level.dat'))).toEqual(level);
});

test('rejects corrupt payloads, changed previews, nonportable paths and ambiguous worlds before publishing', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const world = join(root, 'level.zip');
  const good = await zip({ 'level.dat': level, 'region/r.0.0.mca': 'chunk payload' });
  await writeFile(world, good);
  const { digest } = await launcher.inspectMinecraftWorldArchive(world);
  const changed = await zip({ 'level.dat': level, 'region/r.0.0.mca': 'fresh payload' });
  await writeFile(world, changed);
  await expect(launcher.importMinecraftWorldArchive(left.id, world, digest, 'World')).rejects.toThrow('changed');
  const corrupt = Buffer.from(good);
  corrupt[corrupt.indexOf('chunk payload')] ^= 1;
  await writeFile(world, corrupt);
  const inspected = await launcher.inspectMinecraftWorldArchive(world);
  await expect(launcher.importMinecraftWorldArchive(left.id, world, inspected.digest, 'World')).rejects.toThrow(
    'damaged',
  );
  expect(await stat(pathFor(left.id)).catch(() => null)).toBeNull();
  expect(await launcher.listMinecraftWorlds(left.id)).toEqual([]);

  for (const [entries, message] of [
    [{ 'level.dat': level, 'region/Map.mca': 'A', 'REGION/map.mca': 'B' }, 'conflicting'],
    [{ 'level.dat': level, 'CON.txt': 'A' }, 'non-portable'],
    [{ 'First/level.dat': level, 'Second/level.dat': level }, 'one Minecraft'],
    [{ 'level.dat': 'plain text' }, 'level.dat'],
  ] as const) {
    await writeFile(world, await zip(entries));
    await expect(launcher.inspectMinecraftWorldArchive(world)).rejects.toThrow(message);
  }
});

test('copies a folder only after approving its current tree and preserves the independent source', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const source = join(root, 'Existing world');
  await mkdir(join(source, 'region'), { recursive: true });
  await mkdir(join(source, 'datapacks'));
  await writeFile(join(source, 'level.dat'), level);
  const region = join(source, 'region', 'r.0.0.mca');
  await writeFile(region, 'old');
  await writeFile(join(source, 'session.lock'), 'source lock');
  await writeFile(join(source, 'empty.txt'), '');
  const before = await launcher.inspectMinecraftWorldFolder(source);
  expect(before.folder).toEqual({ name: 'Existing world', files: 3, bytes: level.length + 3 });
  await writeFile(region, 'new');
  await expect(launcher.importMinecraftWorldFolder(left.id, source, before.digest, 'Copy')).rejects.toThrow('changed');
  expect(await launcher.listMinecraftWorlds(left.id)).toEqual([]);

  const after = await launcher.inspectMinecraftWorldFolder(source);
  await launcher.importMinecraftWorldFolder(left.id, source, after.digest, 'Copy');
  await expect(launcher.importMinecraftWorldFolder(left.id, source, after.digest, 'copy')).rejects.toThrow(
    'already has',
  );
  const copied = join(pathFor(left.id), 'Copy');
  expect((await readdir(copied)).sort()).toEqual(['datapacks', 'empty.txt', 'level.dat', 'region']);
  expect(await readFile(join(copied, 'level.dat'))).toEqual(level);
  expect(await readFile(join(copied, 'region', 'r.0.0.mca'), 'utf8')).toBe('new');
  await writeFile(join(copied, 'region', 'r.0.0.mca'), 'independent edit');
  expect(await readFile(region, 'utf8')).toBe('new');
  expect(await readFile(join(source, 'session.lock'), 'utf8')).toBe('source lock');
});

test('requires the matching destination confirmation for a world recorded by a newer release', async () => {
  const { root, launcher, left, pathFor } = await fixture();
  const source = join(root, 'New world');
  const archive = join(root, 'World.zip');
  const world = versionedLevel('26.3');
  await mkdir(source);
  await writeFile(join(source, 'level.dat'), world);
  await writeFile(archive, await zip({ 'level.dat': world }));
  const folderPreview = await launcher.inspectMinecraftWorldFolder(source, left.id);
  const archivePreview = await launcher.inspectMinecraftWorldArchive(archive, left.id);
  const initialRisk = { worldVersion: '26.3', targetVersion: '1.21.1' };
  expect(folderPreview).toMatchObject({ folder: { minecraftVersion: '26.3' }, versionRisk: initialRisk });
  expect(archivePreview).toMatchObject({ archive: { minecraftVersion: '26.3' }, versionRisk: initialRisk });

  await expect(launcher.importMinecraftWorldFolder(left.id, source, folderPreview.digest, 'Folder')).rejects.toThrow(
    'saved by a newer Minecraft release',
  );
  await expect(
    launcher.importMinecraftWorldArchive(left.id, archive, archivePreview.digest, 'Archive'),
  ).rejects.toThrow('saved by a newer Minecraft release');

  const instances = new Instances(join(root, 'desktop'));
  const instance = await instances.find(left.id);
  if (instance.kind !== 'minecraft') throw new Error('Expected a Minecraft instance.');
  await instances.write({ ...instance, minecraft: { ...instance.minecraft, version: '1.20.1' } });
  await expect(
    launcher.importMinecraftWorldFolder(left.id, source, folderPreview.digest, 'Folder', initialRisk),
  ).rejects.toThrow('saved by a newer Minecraft release');
  await expect(
    launcher.importMinecraftWorldArchive(left.id, archive, archivePreview.digest, 'Archive', initialRisk),
  ).rejects.toThrow('saved by a newer Minecraft release');
  expect(await launcher.listMinecraftWorlds(left.id)).toEqual([]);

  const { versionRisk } = await launcher.inspectMinecraftWorldFolder(source, left.id);
  expect(versionRisk).toEqual({ worldVersion: '26.3', targetVersion: '1.20.1' });
  await launcher.importMinecraftWorldFolder(left.id, source, folderPreview.digest, 'Folder', versionRisk);
  await launcher.importMinecraftWorldArchive(left.id, archive, archivePreview.digest, 'Archive', versionRisk);
  expect(await readFile(join(pathFor(left.id), 'Folder', 'level.dat'))).toEqual(world);
  expect(await readFile(join(pathFor(left.id), 'Archive', 'level.dat'))).toEqual(world);
  expect(await readFile(join(source, 'level.dat'))).toEqual(world);

  await writeFile(join(source, 'level.dat'), versionedLevel('26.3', 1));
  const snapshot = await launcher.inspectMinecraftWorldFolder(source, left.id);
  expect(snapshot.folder.minecraftVersion).toBeUndefined();
  expect(snapshot.versionRisk).toBeUndefined();
  await launcher.importMinecraftWorldFolder(left.id, source, snapshot.digest, 'Snapshot');
});

test.skipIf(process.platform === 'win32')('refuses links and a folder in use by another launched game', async () => {
  const { root, launcher, left } = await fixture();
  const source = join(root, 'World');
  await mkdir(source);
  await writeFile(join(source, 'level.dat'), level);
  const alias = join(root, 'Alias');
  await symlink(source, alias);
  await expect(launcher.inspectMinecraftWorldFolder(alias)).rejects.toThrow('regular Minecraft');
  const nested = join(source, 'linked.dat');
  await symlink(join(source, 'level.dat'), nested);
  await expect(launcher.inspectMinecraftWorldFolder(source)).rejects.toThrow('contains a link');
  await rm(nested);

  const executable = join(root, 'running-fixture');
  await writeFile(executable, '#!/bin/sh\nexec sleep 10\n', { mode: 0o700 });
  const active = await launcher.importInstance({
    kind: 'local',
    name: 'Active game',
    executable,
    saveDirectory: source,
  });
  const preview = await launcher.inspectMinecraftWorldFolder(source);
  const session = await launcher.launch(active.id);
  try {
    await expect(launcher.importMinecraftWorldFolder(left.id, source, preview.digest, 'World')).rejects.toThrow(
      'Close the source game',
    );
  } finally {
    await launcher.stopGame(session.sessionId);
  }
  expect(await launcher.importMinecraftWorldFolder(left.id, source, preview.digest, 'World')).toEqual({
    id: 'World',
    name: 'World',
  });
});
