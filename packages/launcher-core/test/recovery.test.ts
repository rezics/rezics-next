import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Saves } from '../src/saves.ts';
import { InstalledStore } from '../src/installed.ts';
import { restoreDirectory, restoreStage, type SaveRestoreJournal } from '../src/save-restore-journal.ts';
import { minecraftWorldRoot } from '../src/saved-worlds.ts';
import { fileInfo, writeJson } from '../src/storage.ts';

const directories: string[] = [];

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'rezics-recovery-test-'));
  directories.push(folder);
  return folder;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('recovers an interrupted save restore with one displaced root', async () => {
  const folder = await fixture();
  const target = join(folder, 'live-save');
  const stage = restoreStage(target, randomUUID(), 0);
  await mkdir(join(stage, 'previous'), { recursive: true });
  await mkdir(target);
  await writeFile(join(target, 'data'), 'snapshot that was being restored');
  await writeFile(join(stage, 'previous', 'data'), 'live save before restore');
  await writeFile(
    join(folder, 'restore-journal.json'),
    JSON.stringify({ phase: 'moving', items: [{ rootId: 'one', stage, target, existed: true }] }),
  );
  await new Saves(folder, async () => [{ id: 'one', path: target }]).recover();
  expect(await readFile(join(target, 'data'), 'utf8')).toBe('live save before restore');
  await expect(readFile(join(folder, 'restore-journal.json'))).rejects.toThrow();
});

test('validates all journal paths before recovering any root', async () => {
  const folder = await fixture();
  const operation = randomUUID();
  const first = join(folder, 'one');
  const second = join(folder, 'two');
  const unowned = join(folder, 'unrelated');
  const stage = restoreStage(first, operation, 0);
  const log = join(folder, 'restore-journal.json');
  await mkdir(join(stage, 'previous'), { recursive: true });
  await Promise.all([mkdir(first), mkdir(second), mkdir(unowned)]);
  await writeFile(join(first, 'current'), 'keep until the operation can be verified');
  await writeFile(join(stage, 'previous', 'current'), 'recoverable original');
  await writeFile(join(unowned, 'current'), 'unrelated');
  const saves = new Saves(folder, async () => [
    { id: 'one', path: first },
    { id: 'two', path: second },
  ]);
  for (const item of [
    { rootId: 'two', target: unowned, stage: restoreStage(unowned, operation, 1), existed: false },
    { rootId: 'two', target: second, stage: unowned, existed: false },
  ]) {
    await writeJson(log, { phase: 'moving', items: [{ rootId: 'one', target: first, stage, existed: true }, item] });
    await expect(saves.recoverRestore()).rejects.toThrow('could not be verified');
    expect(await readFile(join(first, 'current'), 'utf8')).toBe('keep until the operation can be verified');
    expect(await readFile(join(stage, 'previous', 'current'), 'utf8')).toBe('recoverable original');
    expect(await readFile(join(unowned, 'current'), 'utf8')).toBe('unrelated');
    expect(await fileInfo(log)).toBeDefined();
  }
});

test('preserves a replaced world, then rolls back the original interrupted publication on retry', async () => {
  const folder = await fixture();
  const game = join(folder, 'game');
  const worlds = join(game, 'saves');
  const selection = { kind: 'world', id: 'New World' } as const;
  const target = join(worlds, selection.id);
  const sibling = join(worlds, 'Sibling');
  const operation = randomUUID();
  const stage = restoreStage(target, operation, 0);
  const displaced = join(worlds, 'Moved World');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, 'level.dat'), 'untouched world');
  await mkdir(join(stage, 'next'), { recursive: true });
  await writeFile(join(stage, 'next', 'level.dat'), 'staged restoration');
  const incoming = await restoreDirectory(join(stage, 'next'));
  const parent = await restoreDirectory(worlds);
  if (!incoming || !parent) throw new Error('The restore fixture directories were not created.');
  const log = join(folder, 'restore-journal.json');
  await writeJson(log, {
    version: 2,
    operation,
    phase: 'moving',
    selection,
    items: [{ rootId: 'world', target, before: null, incoming, parent }],
  } satisfies SaveRestoreJournal);
  await rename(join(stage, 'next'), target);
  await rename(target, displaced);
  await mkdir(target);
  await writeFile(join(target, 'level.dat'), 'a new world created independently');
  const saves = new Saves(folder, async (scope) => [await minecraftWorldRoot(game, scope!, true)]);
  await expect(saves.recoverRestore()).rejects.toThrow('directory changed outside Launcher');
  expect(await readFile(join(target, 'level.dat'), 'utf8')).toBe('a new world created independently');
  expect(await readFile(join(displaced, 'level.dat'), 'utf8')).toBe('staged restoration');
  expect(await fileInfo(log)).toBeDefined();

  await rename(target, join(worlds, 'Keep replacement'));
  await rename(displaced, target);
  await saves.recoverRestore();
  await saves.recoverRestore();
  expect(await fileInfo(target)).toBeUndefined();
  expect(await fileInfo(stage)).toBeUndefined();
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('untouched world');
  expect(await readFile(join(worlds, 'Keep replacement', 'level.dat'), 'utf8')).toBe(
    'a new world created independently',
  );
  expect(await fileInfo(log)).toBeUndefined();
});

test('recovers old files after an interrupted package update before ledger commit', async () => {
  const folder = await fixture();
  const mods = join(folder, 'mods');
  const stage = join(folder, 'install-staging');
  const jar = (id: string) => `rezics-${createHash('sha256').update(id).digest('hex')}.jar`;
  const previous = jar('old');
  const incoming = jar('new');
  const journal = join(stage, 'journal.json');
  const changes = [
    { file: previous, previous: true, next: true },
    { file: incoming, previous: false, next: true },
  ];
  const store = new InstalledStore(folder, mods);
  await mkdir(mods);
  await mkdir(join(stage, 'previous'), { recursive: true });
  await mkdir(join(stage, 'next'));
  await writeJson(join(folder, 'installed.json'), { packages: [{ id: 'old', enabled: true }] });
  await writeFile(join(folder, 'world'), 'keep this world');
  await writeFile(join(mods, previous), 'uncommitted update');
  await writeFile(join(stage, 'previous', previous), 'last installed');
  await writeFile(join(stage, 'next', previous), 'uncommitted update');
  await writeFile(join(stage, 'next', incoming), 'uncommitted new artifact');
  await writeFile(join(mods, incoming), 'an independently replaced JAR');

  const id = randomUUID();
  for (const entries of [[changes[0], { ...changes[1], file: '../world' }], changes]) {
    await writeJson(journal, { id, changes: entries });
    await expect(store.recover()).rejects.toThrow('could not be verified');
    expect(await readFile(join(mods, previous), 'utf8')).toBe('uncommitted update');
    expect(await readFile(join(mods, incoming), 'utf8')).toBe('an independently replaced JAR');
    expect(await readFile(join(folder, 'world'), 'utf8')).toBe('keep this world');
    expect(await fileInfo(journal)).toBeDefined();
  }

  await writeFile(join(mods, incoming), 'uncommitted new artifact');
  await store.recover();
  expect(await readFile(join(mods, previous), 'utf8')).toBe('last installed');
  expect(await fileInfo(join(mods, incoming))).toBeUndefined();
  expect(await fileInfo(stage)).toBeUndefined();
});

test('finishes the package transaction if cancellation arrives at publication', async () => {
  const folder = await fixture();
  const store = new InstalledStore(folder);
  const controller = new AbortController();
  const next = [
    {
      id: 'fixture.panel',
      title: 'Panel',
      version: '1.0.0',
      releaseId: 'installed',
      source: 'rezics' as const,
      enabled: true,
      requires: [],
      conflicts: [],
      panel: { id: 'fixture.panel', title: 'Panel', text: 'Panel contents' },
    },
  ];
  await store.edit(async () => ({ next, artifacts: new Map() }), {
    signal: controller.signal,
    beginCommit: () => controller.abort(),
  });
  expect(controller.signal.aborted).toBeTrue();
  expect(await store.list()).toEqual(next);
  expect(await fileInfo(join(folder, 'install-staging'))).toBeUndefined();
});

test('save and mod recovery refuse linked roots without changing the linked files', async () => {
  const folder = await fixture();
  const external = join(folder, 'external');
  const games = join(folder, 'owned');
  const modRoot = join(games, 'installed-mods');
  const stage = join(modRoot, 'install-staging');
  await mkdir(stage, { recursive: true });
  await mkdir(join(external, 'mods'), { recursive: true });
  await mkdir(join(external, '.pending'));
  await writeFile(join(external, '.pending', 'pending-world'), 'keep');
  await writeFile(join(external, 'mods', 'fixture.jar'), 'keep');
  await symlink(external, join(games, 'snapshots'), 'junction');
  await symlink(external, join(games, 'game'), 'junction');
  await writeFile(
    join(stage, 'journal.json'),
    JSON.stringify({ id: 'partial', changes: [{ file: 'fixture.jar', previous: false, next: true }] }),
  );
  await expect(new Saves(games, async () => []).recover()).rejects.toThrow('is a link');
  await expect(new InstalledStore(modRoot, join(games, 'game', 'mods')).recover()).rejects.toThrow('is a link');
  expect(await readFile(join(external, '.pending', 'pending-world'), 'utf8')).toBe('keep');
  expect(await readFile(join(external, 'mods', 'fixture.jar'), 'utf8')).toBe('keep');
});
