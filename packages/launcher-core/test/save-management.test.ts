import type { SaveSelection, Snapshot } from '@rezics/launcher-contract';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameLinuxDirectory } from '../src/directory-move.ts';
import { restoreDirectory } from '../src/save-restore-journal.ts';
import { listMinecraftWorlds, minecraftWorldRoot } from '../src/saved-worlds.ts';
import { Saves } from '../src/saves.ts';
import { levelSavedIn } from './fixtures/minecraft-level.ts';

const temporary = fileURLToPath(new URL('../.temp/', import.meta.url));
const directories: string[] = [];
const selection: SaveSelection = { kind: 'world', id: '村 Test' };
const context: NonNullable<Snapshot['minecraft']> = { version: '1.21.1', loader: 'vanilla', mods: [] };

async function setup() {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'save-management-'));
  directories.push(directory);
  const instance = join(directory, 'instance');
  const game = join(instance, 'game');
  const worlds = join(game, 'saves');
  const world = join(worlds, selection.id);
  const sibling = join(worlds, 'Other World');
  await Promise.all([mkdir(world, { recursive: true }), mkdir(sibling, { recursive: true })]);
  await Promise.all([
    writeFile(join(world, 'level.dat'), 'old contents'),
    writeFile(join(sibling, 'level.dat'), 'sibling'),
  ]);
  return {
    directory,
    instance,
    game,
    world,
    sibling,
    saves: new Saves(instance, (scope) => scopedWorlds(game, scope)),
  };
}

async function scopedWorlds(game: string, scope?: SaveSelection) {
  return scope ? [await minecraftWorldRoot(game, scope, true)] : [{ id: 'worlds', path: join(game, 'saves') }];
}

test('cleans a staged visual novel restore if the configured destination changes before commit', async () => {
  const { directory, instance } = await setup();
  const destination = join(directory, 'visual-novel');
  const changed = join(directory, 'different-folder');
  await Promise.all([mkdir(destination), mkdir(changed)]);
  await writeFile(join(destination, 'slot'), 'before restore');
  await writeFile(join(changed, 'slot'), 'other contents');
  const roots = [{ id: 'selected', path: destination }];
  const saves = new Saves(instance, async () => [{ id: 'selected', path: changed }], 'visual-novel');
  const snapshot = await saves.create(roots, undefined);
  const review = (await saves.preview(snapshot.id, roots)).review!;
  await writeFile(join(destination, 'slot'), 'live save');
  await expect(saves.restore(snapshot.id, undefined, undefined, { review, allowedRoots: roots })).rejects.toThrow(
    'destinations changed',
  );
  expect(await readFile(join(destination, 'slot'), 'utf8')).toBe('live save');
  expect(await readFile(join(changed, 'slot'), 'utf8')).toBe('other contents');
  expect(await saves.list()).toEqual([snapshot]);
  expect((await readdir(directory)).some((name) => name.startsWith('.rezics-restore-'))).toBeFalse();
  expect(await readdir(instance)).not.toContain('restore-journal.json');
});

test.skipIf(process.platform !== 'linux')('preserves late save destinations during restore and recovery', async () => {
  const { directory, instance } = await setup();
  const destination = join(directory, 'visual-novel');
  const roots = [{ id: 'selected', path: destination }];
  let race: 'next' | 'previous' | undefined = 'next';
  let stage: string | undefined;
  let competing: Awaited<ReturnType<typeof restoreDirectory>>;
  const saves = new Saves(
    instance,
    async () => roots,
    'visual-novel',
    async (source, target) => {
      if (target === destination && basename(source) === race) {
        stage = dirname(source);
        await mkdir(destination);
        competing = await restoreDirectory(destination);
      }
      return renameLinuxDirectory(source, target);
    },
  );
  await mkdir(destination);
  await writeFile(join(destination, 'slot'), 'in the snapshot');
  const snapshot = await saves.create(roots, undefined);
  await writeFile(join(destination, 'slot'), 'latest player save');

  const review = (await saves.preview(snapshot.id, roots)).review!;
  await expect(saves.restore(snapshot.id, undefined, undefined, { review })).rejects.toThrow('directory changed');
  if (!stage) throw new Error('The restore never tried to publish its staged save.');
  expect(await restoreDirectory(destination)).toEqual(competing!);
  expect(await readdir(destination)).toEqual([]);
  expect(await readFile(join(stage, 'previous', 'slot'), 'utf8')).toBe('latest player save');
  expect(await readFile(join(stage, 'next', 'slot'), 'utf8')).toBe('in the snapshot');

  await rm(destination, { recursive: true });
  race = 'previous';
  await expect(saves.recoverRestore()).rejects.toThrow('directory changed');
  expect(await restoreDirectory(destination)).toEqual(competing!);
  expect(await readdir(destination)).toEqual([]);
  expect(await readFile(join(stage, 'previous', 'slot'), 'utf8')).toBe('latest player save');
  expect(await readdir(instance)).toContain('restore-journal.json');

  await rm(destination, { recursive: true });
  race = undefined;
  await saves.recoverRestore();
  expect(await readFile(join(destination, 'slot'), 'utf8')).toBe('latest player save');
  expect(await readdir(instance)).not.toContain('restore-journal.json');
  expect(await readdir(directory)).not.toContain(basename(stage));
  await saves.restore(snapshot.id, undefined, undefined, { review: (await saves.preview(snapshot.id, roots)).review! });
  expect(await readFile(join(destination, 'slot'), 'utf8')).toBe('in the snapshot');
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('discovers and restores only one named world, including its recovery backup', async () => {
  const { directory, game, world, sibling, saves } = await setup();
  const anotherInstance = join(directory, 'other', 'game', 'saves', selection.id);
  await mkdir(anotherInstance, { recursive: true });
  await writeFile(join(anotherInstance, 'level.dat'), 'independent instance');
  await mkdir(join(game, 'saves', 'not-a-world'));

  const listed = await listMinecraftWorlds(game);
  expect(listed).toHaveLength(2);
  expect(listed).toContainEqual({ id: selection.id, name: selection.id });
  const root = await minecraftWorldRoot(game, selection);
  const snapshot = await saves.create([root], context, 'Before building', selection);
  await writeFile(join(world, 'level.dat'), 'changed world');

  expect(await saves.selection(snapshot.id)).toEqual(selection);
  expect((await saves.preview(snapshot.id, [root])).targets).toEqual([{ path: world, files: 1, bytes: 12 }]);
  await saves.restore(snapshot.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('old contents');
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');
  expect(await readFile(join(anotherInstance, 'level.dat'), 'utf8')).toBe('independent instance');

  const recovery = (await saves.list()).find((row) => row.label === 'Before restore');
  expect(recovery?.selection).toEqual(selection);
  await saves.restore(recovery!.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('changed world');

  await rm(join(world, 'level.dat'));
  await writeFile(join(world, 'level.dat_old'), 'remaining level data');
  await expect(minecraftWorldRoot(game, selection)).rejects.toThrow('unavailable');
  await saves.restore(snapshot.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('old contents');
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');

  const partialBackup = (await saves.list()).find((row) => row.label === 'Before restore' && row.bytes === 20);
  expect(partialBackup?.selection).toEqual(selection);
  const bundle = await saves.exportSnapshot(partialBackup!.id, directory);
  expect(
    await saves.importSnapshot(bundle, 'minecraft', async () => [await minecraftWorldRoot(game, selection, true)]),
  ).toMatchObject({ selection, files: 1, bytes: 20 });
});

test('reuses only the latest verified automatic backup for the exact save and Minecraft selection', async () => {
  const { instance, game, world, saves } = await setup();
  const roots = await scopedWorlds(game);
  const original = await saves.createAutomatic(roots, context);
  const manual = await saves.create(roots, context, 'Automatic backup');
  await saves.setPinned(original.id, true);

  const reopened = new Saves(instance, (scope) => scopedWorlds(game, scope));
  const same = await reopened.createAutomatic(roots, context);
  expect(same).toMatchObject({ id: original.id, createdAt: original.createdAt, pinned: true });
  expect((await saves.list()).map(({ id }) => id).sort()).toEqual([original.id, manual.id].sort());

  await writeFile(join(world, 'level.dat'), 'new contents');
  const changed = await reopened.createAutomatic(roots, context);
  expect(changed.id).not.toBe(original.id);
  expect(changed.bytes).toBe(original.bytes);
  const damaged = join(instance, 'snapshots', changed.id, 'worlds', selection.id, 'level.dat');
  await writeFile(damaged, 'NEW contents');
  const rebuilt = await reopened.createAutomatic(roots, context);
  expect(rebuilt.id).not.toBe(changed.id);
  expect(await readFile(damaged, 'utf8')).toBe('NEW contents');

  const nextRelease = { ...context, version: '26.3' };
  const upgraded = await reopened.createAutomatic(roots, nextRelease);
  expect(upgraded.id).not.toBe(rebuilt.id);
  expect(upgraded.minecraft).toEqual(nextRelease);
  await reopened.delete(upgraded.id);
  expect((await reopened.createAutomatic(roots, nextRelease)).id).not.toBe(upgraded.id);
});

test('keeps a pinned snapshot and portable world data through a move to another instance', async () => {
  const { directory, instance, game, saves } = await setup();
  const out = join(directory, 'portable');
  await mkdir(out);
  const snapshot = await saves.create([await minecraftWorldRoot(game, selection)], context, 'Keep my build', selection);
  await saves.setPinned(snapshot.id, true);
  await expect(saves.delete(snapshot.id)).rejects.toThrow('Unpin');
  expect((await saves.list())[0]?.pinned).toBeTrue();
  await expect(saves.exportSnapshot(snapshot.id, join(instance, 'snapshots', snapshot.id))).rejects.toThrow('outside');

  const bundle = await saves.exportSnapshot(snapshot.id, out);
  const manifest = await readFile(join(bundle, 'backup.json'), 'utf8');
  expect(manifest).not.toContain(instance);
  expect(manifest).not.toContain(snapshot.id);
  const newInstance = join(directory, 'another-instance');
  const newGame = join(newInstance, 'game');
  const roots = (scope?: SaveSelection) => scopedWorlds(newGame, scope);
  const other = new Saves(newInstance, roots);

  await expect(other.importSnapshot(bundle, 'visual-novel', roots)).rejects.toThrow('different type');
  await expect(other.importSnapshot(bundle, 'minecraft', async () => [])).rejects.toThrow('does not have');
  const imported = await other.importSnapshot(bundle, 'minecraft', roots);
  expect(imported).toMatchObject({
    label: 'Keep my build',
    pinned: true,
    selection,
    createdAt: snapshot.createdAt,
    minecraft: context,
  });
  expect(imported.id).not.toBe(snapshot.id);
  await expect(other.delete(imported.id)).rejects.toThrow('Unpin');
  const destination = await minecraftWorldRoot(newGame, selection, true);
  await other.restore(imported.id, context);
  expect(await readFile(join(destination.path, 'level.dat'), 'utf8')).toBe('old contents');

  await writeFile(join(bundle, 'data', destination.id, 'level.dat'), 'OLD contents');
  await expect(other.importSnapshot(bundle, 'minecraft', roots)).rejects.toThrow('do not match');
  expect((await other.list()).map((row) => row.id)).toEqual([imported.id]);
  await writeFile(join(newInstance, 'snapshots', imported.id, destination.id, 'level.dat'), 'OLD contents');
  await expect(other.restore(imported.id, context)).rejects.toThrow('Your current saves were kept');
  expect(await readFile(join(destination.path, 'level.dat'), 'utf8')).toBe('old contents');

  await saves.setPinned(snapshot.id, false);
  await saves.delete(snapshot.id);
  expect(await saves.list()).toEqual([]);
  expect(await readFile(join(destination.path, 'level.dat'), 'utf8')).toBe('old contents');
});

test('checks local restore and export without replacing a world or publishing a damaged backup', async () => {
  const { directory, instance, game, world, sibling, saves } = await setup();
  const root = await minecraftWorldRoot(game, selection);
  await mkdir(join(world, 'empty'));
  const snapshot = await saves.create([root], context, undefined, selection);
  const stored = join(instance, 'snapshots', snapshot.id, root.id);
  await writeFile(join(world, 'level.dat'), 'live world');

  await writeFile(join(stored, 'level.dat'), 'OLD contents');
  await expect(saves.restore(snapshot.id, context)).rejects.toThrow('Your current saves were kept');
  await expect(saves.exportSnapshot(snapshot.id, directory)).rejects.toThrow('This backup is damaged');
  expect(await readdir(directory)).toEqual(['instance']);
  expect((await saves.list()).map(({ id }) => id)).toEqual([snapshot.id]);
  expect((await readdir(join(game, 'saves'))).sort()).toEqual(['Other World', selection.id]);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('live world');
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');

  await writeFile(join(stored, 'level.dat'), 'old contents');
  await rm(join(stored, 'empty'), { recursive: true });
  await expect(saves.restore(snapshot.id, context)).rejects.toThrow('This backup is damaged');
  await mkdir(join(stored, 'empty'));
  await saves.restore(snapshot.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('old contents');
  expect(await readdir(join(world, 'empty'))).toEqual([]);

  const manifest = join(instance, 'snapshots', snapshot.id, 'snapshot.json');
  const legacy = JSON.parse(await readFile(manifest, 'utf8'));
  delete legacy.roots[0].sha256;
  await writeFile(manifest, JSON.stringify(legacy));
  await writeFile(join(world, 'level.dat'), 'live world again');
  await writeFile(join(stored, 'level.dat'), 'short');
  await expect(saves.restore(snapshot.id, context)).rejects.toThrow('This backup is damaged');
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('live world again');
  await writeFile(join(stored, 'level.dat'), 'old contents');
  await saves.restore(snapshot.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('old contents');
});

test('rejects traversing and linked world folders and linked backup contents', async () => {
  const { directory, game, world, saves } = await setup();
  const linked = join(game, 'saves', 'Linked');
  await symlink(world, linked, 'junction');
  expect((await listMinecraftWorlds(game)).map(({ id }) => id)).not.toContain('Linked');
  await expect(minecraftWorldRoot(game, { kind: 'world', id: 'Linked' }, true)).rejects.toThrow('linked');
  await expect(minecraftWorldRoot(game, { kind: 'world', id: '../Outside' }, true)).rejects.toThrow('valid');
  await expect(minecraftWorldRoot(game, { kind: 'world', id: 'CON.txt' }, true)).rejects.toThrow('valid');

  const snapshot = await saves.create([await minecraftWorldRoot(game, selection)], context, undefined, selection);
  const bundle = await saves.exportSnapshot(snapshot.id, directory);
  await symlink(world, join(bundle, 'data', 'world', 'external'), 'junction');
  const other = new Saves(join(directory, 'other'), (scope) => scopedWorlds(game, scope));
  await expect(
    other.importSnapshot(bundle, 'minecraft', async () => [await minecraftWorldRoot(game, selection)]),
  ).rejects.toThrow('special file');
  expect(await other.list()).toEqual([]);
});

test('requires the current version warning before restoring a newer portable world', async () => {
  const { directory, game, world, sibling, saves } = await setup();
  const newer = { ...context, version: '26.3' };
  const root = await minecraftWorldRoot(game, selection);
  const original = await saves.create([root], newer, 'Newer world', selection);
  const bundle = await saves.exportSnapshot(original.id, directory);
  await saves.delete(original.id);
  await writeFile(join(world, 'level.dat'), 'live older world');
  const imported = await saves.importSnapshot(bundle, 'minecraft', (scope) => scopedWorlds(game, scope));

  const risk = { backupVersion: '26.3', targetVersion: context.version };
  expect(await saves.preview(imported.id, [root], context.version)).toMatchObject({ minecraftVersionRisk: risk });
  expect((await saves.preview(imported.id, [root], newer.version)).minecraftVersionRisk).toBeUndefined();
  await expect(saves.restore(imported.id, context)).rejects.toThrow('confirm the Minecraft version warning');
  await expect(saves.restore(imported.id, context, { ...risk, targetVersion: '1.20.1' })).rejects.toThrow(
    'Preview this backup again',
  );
  await expect(saves.restore(imported.id, newer, risk)).rejects.toThrow('Preview this backup again');
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('live older world');
  expect((await saves.list()).map(({ id }) => id)).toEqual([imported.id]);

  await saves.restore(imported.id, context, risk);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('old contents');
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');
  const recovery = (await saves.list()).find(({ label }) => label === 'Before restore');
  expect(recovery).toMatchObject({ selection, minecraft: context });
  await saves.restore(recovery!.id, context);
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('live older world');
});

test('uses the saved world release across named, whole-instance, older and imported backups', async () => {
  const { directory, instance, game, world, sibling, saves } = await setup();
  const newerWorld = levelSavedIn('26.3');
  const newerSibling = levelSavedIn('26.3.1');
  await writeFile(join(world, 'level.dat'), newerWorld);
  await writeFile(join(sibling, 'level.dat'), newerSibling);
  const root = await minecraftWorldRoot(game, selection);
  const worldRisk = { backupVersion: '26.3', targetVersion: context.version, source: 'world' } as const;
  const allRoots = await scopedWorlds(game);
  const named = await saves.create([root], context, undefined, selection);
  const all = await saves.createAutomatic(allRoots, context);

  expect(named.minecraft).toEqual(context);
  expect((await saves.preview(named.id, [root], context.version)).minecraftVersionRisk).toEqual(worldRisk);
  expect((await saves.preview(all.id, allRoots, context.version)).minecraftVersionRisk).toEqual({
    ...worldRisk,
    backupVersion: '26.3.1',
  });
  expect((await saves.preview(named.id, [root], '26.3')).minecraftVersionRisk).toBeUndefined();

  const metadata = join(instance, 'snapshots', named.id, 'snapshot.json');
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  delete record.newestWorldVersion;
  await writeFile(metadata, JSON.stringify(record));
  expect((await saves.preview(named.id, [root], context.version)).minecraftVersionRisk).toEqual(worldRisk);
  await expect(saves.restore(named.id, context)).rejects.toThrow('confirm the Minecraft version warning');

  const bundle = await saves.exportSnapshot(named.id, directory);
  const portable = JSON.parse(await readFile(join(bundle, 'backup.json'), 'utf8'));
  expect(portable.version).toBe(1);
  expect(portable.snapshot).not.toHaveProperty('newestWorldVersion');
  const imported = await saves.importSnapshot(bundle, 'minecraft', (scope) => scopedWorlds(game, scope));
  expect((await saves.preview(imported.id, [root], context.version)).minecraftVersionRisk).toEqual(worldRisk);
  await writeFile(join(world, 'level.dat'), 'live save before restore');
  await expect(saves.restore(imported.id, context)).rejects.toThrow('confirm the Minecraft version warning');
  await saves.restore(imported.id, context, worldRisk);
  expect(await readFile(join(world, 'level.dat'))).toEqual(newerWorld);
  expect(await readFile(join(sibling, 'level.dat'))).toEqual(newerSibling);
});

test('rechecks the verified world bytes when the cached release differs and leaves live saves unchanged', async () => {
  const { instance, game, world, sibling, saves } = await setup();
  const root = await minecraftWorldRoot(game, selection);
  await writeFile(join(world, 'level.dat'), levelSavedIn('26.3'));
  const snapshot = await saves.create([root], context, undefined, selection);
  const metadata = join(instance, 'snapshots', snapshot.id, 'snapshot.json');
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  await writeFile(metadata, JSON.stringify({ ...record, newestWorldVersion: null }));
  await writeFile(join(world, 'level.dat'), 'live save before review');

  expect((await saves.preview(snapshot.id, [root], context.version)).minecraftVersionRisk).toBeUndefined();
  await expect(saves.restore(snapshot.id, context)).rejects.toThrow('confirm the Minecraft version warning');
  expect(await readFile(join(world, 'level.dat'), 'utf8')).toBe('live save before review');
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');
  expect((await saves.list()).map(({ id }) => id)).toEqual([snapshot.id]);
  expect((await saves.preview(snapshot.id, [root], context.version)).minecraftVersionRisk).toEqual({
    backupVersion: '26.3',
    targetVersion: context.version,
    source: 'world',
  });
});
