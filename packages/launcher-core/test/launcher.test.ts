import type { PackageInstallProgress, Session } from '@rezics/launcher-contract';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createLauncher } from '../src/index.ts';
import { InstalledStore } from '../src/installed.ts';
import { Instances } from '../src/instances.ts';
import { fabricModJar as jar } from './fixtures/mod-jar.ts';

const directories: string[] = [];
const hash = (bytes: Buffer, algorithm: 'sha256' | 'sha512') => createHash(algorithm).update(bytes).digest('hex');

test('publishes a pack as a new instance only after its isolated content is ready', async () => {
  const { dataDir } = await fixture();
  const instances = new Instances(dataDir);
  const input = { name: 'Imported pack', loader: 'vanilla' } as const;
  const selection = { version: '1.21.1', loader: 'vanilla' } as const;
  const staging = join(dataDir, 'instances', '.modrinth-import');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'interrupted'), 'left by a previous process');

  await expect(
    instances.publishMinecraftImport(input, selection, async (directory) => {
      expect(await readdir(directory)).toEqual([]);
      expect(await instances.list()).toEqual([]);
      await writeFile(join(directory, 'partial'), 'failed staging');
      throw new Error('Pack download failed.');
    }),
  ).rejects.toThrow('Pack download failed.');
  expect(await instances.list()).toEqual([]);

  const imported = await instances.publishMinecraftImport(input, selection, async (_directory, game) => {
    await mkdir(game);
    await writeFile(join(game, 'pack-file'), 'verified contents');
  });
  expect(await readFile(join(instances.gamePath(imported.id), 'pack-file'), 'utf8')).toBe('verified contents');
  expect(await instances.list()).toEqual([imported]);
  expect(await readdir(join(dataDir, 'instances'))).toEqual([imported.id]);
});

async function fixture(fetcher?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'rezics-launcher-test-'));
  directories.push(directory);
  const dataDir = join(directory, 'launcher');
  const opened: string[] = [];
  const launcher = createLauncher({
    dataDir,
    catalogUrl: 'https://catalog.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    ...(fetcher && { fetch: fetcher }),
    async openExternal(url) {
      opened.push(url);
    },
  });
  return { launcher, opened, directory, dataDir };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test.skipIf(process.platform === 'win32')(
  'imports a fixture, tracks its process, and backs up and restores its save',
  async () => {
    const { launcher, opened, directory } = await fixture();
    const exe = join(directory, 'fixture');
    const external = join(directory, 'external-storage');
    await mkdir(external);
    await writeFile(exe, '#!/bin/sh\nprintf "Ready on fixture\\n"\nsleep 0.6\nprintf "Finished fixture\\n" >&2\n', {
      mode: 0o700,
    });
    const game = await launcher.importInstance({
      kind: 'visual-novel',
      name: 'Story fixture',
      executable: exe,
      saveDirectory: external,
      subjectId: 'a1234567-982e-478a-aaaa-deadbeefcafe',
    });
    const save = join(external, 'persistent');
    await writeFile(save, 'original progress');

    expect((await launcher.footprintStatus()).enabled).toBe(false);
    await launcher.setFootprintRecording(true);
    expect(launcher.gameWorkState()).toBe('idle');
    const starting = launcher.launch(game.id);
    expect(launcher.gameWorkState()).toBe('playing');
    const session = await starting;
    expect(session.instanceId).toEqual(game.id);
    expect(session.pid).toBeGreaterThan(0);
    await launcher.openDestination(session.sessionId, 'info');
    expect(opened).toEqual(['https://rezics.example.invalid/subjects/a1234567-982e-478a-aaaa-deadbeefcafe']);
    await expect(launcher.launch(game.id)).rejects.toThrow('Close the current game');
    await expect(launcher.createSnapshot(game.id)).rejects.toThrow('Close the game');
    await launcher.waitForGameWork();
    expect(launcher.gameWorkState()).toBe('idle');
    const exported = join(directory, 'footprints.jsonl');
    await launcher.exportFootprints(exported);
    const [header, run] = (await readFile(exported, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(header).toEqual({ format: 'rezics-launcher-footprints', version: 1 });
    expect(run).toMatchObject({
      originId: session.sessionId,
      targetId: game.subjectId,
      startedAt: new Date(session.startedAt).toISOString(),
    });
    expect(Date.parse(run.endedAt)).toBeGreaterThan(session.startedAt);
    expect(await launcher.currentSession()).toBeNull();
    expect(await launcher.readLaunchReport(game.id)).toMatchObject({
      state: 'exited',
      exitCode: 0,
      output: 'Ready on fixture\nFinished fixture\n',
    });
    await expect(launcher.openDestination(session.sessionId, 'info')).rejects.toThrow('no longer available');
    const [snapshot] = await launcher.listSnapshots(game.id);
    expect(snapshot).toMatchObject({ files: 1, bytes: 17 });
    await writeFile(save, 'new progress');
    expect((await launcher.previewRestore(game.id, snapshot!.id)).targets).toEqual([
      { path: external, files: 1, bytes: 17 },
    ]);
    await launcher.restoreSnapshot(game.id, snapshot!.id);
    expect(await readFile(save, 'utf8')).toBe('original progress');
    expect((await launcher.listSnapshots(game.id)).some((entry) => entry.label === 'Before restore')).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')('forces only the current game session to stop', async () => {
  const { launcher, directory } = await fixture();
  const exe = join(directory, 'running-fixture');
  const saveDir = join(directory, 'saves');
  await mkdir(saveDir);
  await writeFile(join(saveDir, 'checkpoint'), 'saved');
  await writeFile(exe, '#!/bin/sh\nexec sleep 20\n', { mode: 0o700 });
  const instance = await launcher.importInstance({ kind: 'local', name: 'Running fixture', executable: exe });

  async function stopAndWait(sessionId: string) {
    let notifications = 0;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = launcher.subscribe((session) => {
      if (!session && ++notifications === 2) finish();
    });
    try {
      await launcher.stopGame(sessionId);
      await Promise.race([
        done,
        setTimeout(3000, undefined, { ref: false }).then(() => {
          throw new Error('Stopped fixture did not finish backing up');
        }),
      ]);
    } finally {
      unsubscribe();
    }
  }

  const first = await launcher.launch(instance.id);
  try {
    await expect(launcher.stopGame('unknown-session')).rejects.toThrow('no longer running');
    expect((await launcher.currentSession())?.sessionId).toBe(first.sessionId);
    await stopAndWait(first.sessionId);
    const second = await launcher.launch(instance.id);
    await expect(launcher.stopGame(first.sessionId)).rejects.toThrow('no longer running');
    expect((await launcher.currentSession())?.sessionId).toBe(second.sessionId);
    await stopAndWait(second.sessionId);
    expect(await launcher.currentSession()).toBeNull();
  } finally {
    const active = await launcher.currentSession();
    if (active) await stopAndWait(active.sessionId);
  }
});

test.skipIf(process.platform === 'win32')(
  'skips an automatic backup until the game produces a save folder',
  async () => {
    const { launcher, directory, dataDir } = await fixture();
    const executable = join(directory, 'fixture');
    const saves = join(directory, 'saves');
    await writeFile(executable, '#!/bin/sh\nsleep 0.1\nexit 17\n', { mode: 0o700 });
    const instance = await launcher.importInstance({ kind: 'local', name: 'Game without saves', executable });
    const home = join(dataDir, 'instances', instance.id);
    const statusPath = join(home, 'backup-failure.json');
    const legacy = JSON.stringify({ message: 'No save folder is available for this instance.' });
    await writeFile(statusPath, legacy);
    expect(await launcher.automaticBackupStatus(instance.id)).toEqual({ state: 'idle' });

    await launcher.launch(instance.id);
    await launcher.waitForGameWork();
    expect(await launcher.readLaunchReport(instance.id)).toMatchObject({ state: 'failed', exitCode: 17 });
    expect(await launcher.automaticBackupStatus(instance.id)).toEqual({ state: 'idle' });
    expect(await launcher.listSnapshots(instance.id)).toEqual([]);
    expect(await readdir(home)).not.toContain('snapshots');
    await expect(launcher.retryAutomaticBackup(instance.id)).rejects.toThrow('No save folder is available');
    await expect(launcher.createSnapshot(instance.id)).rejects.toThrow('No save folder is available');
    expect(await readFile(statusPath, 'utf8')).toBe(legacy);

    await mkdir(saves);
    await writeFile(join(saves, 'slot'), 'first save');
    await launcher.launch(instance.id);
    await launcher.waitForGameWork();
    expect(await launcher.listSnapshots(instance.id)).toMatchObject([{ label: 'Automatic backup', files: 1 }]);
    expect(await launcher.lastBackupFailure(instance.id)).toBeNull();
  },
);

test.skipIf(process.platform === 'win32')(
  'reports a failed automatic backup separately and keeps the game launchable',
  async () => {
    const { launcher, directory, dataDir } = await fixture();
    const gamePath = join(directory, 'game');
    const saves = join(gamePath, 'saves');
    await mkdir(saves, { recursive: true });
    const executable = join(gamePath, 'fixture');
    await writeFile(executable, '#!/bin/sh\nsleep 0.1\nprintf saved > saves/checkpoint\nexit 17\n', { mode: 0o700 });
    const instance = await launcher.importInstance({ kind: 'local', name: 'Crash fixture', executable });
    const snapshots = join(dataDir, 'instances', instance.id, 'snapshots');
    await writeFile(snapshots, 'obstructed snapshot folder');

    async function runWithFailedBackup() {
      const failed = Promise.withResolvers<string>();
      const end = launcher.subscribeAutomaticBackup((id, status) => {
        if (id === instance.id && status.state === 'failed') failed.resolve(status.message);
      });
      try {
        const session = await launcher.launch(instance.id);
        const failure = await failed.promise;
        expect(await launcher.currentSession()).toBeNull();
        expect(await launcher.readLaunchReport(instance.id)).toMatchObject({ state: 'failed', exitCode: 17 });
        return { session, failure };
      } finally {
        end();
      }
    }
    const first = await runWithFailedBackup();
    expect(first.failure).toContain('snapshots folder');
    const reopened = createLauncher({
      dataDir,
      catalogUrl: 'https://catalog.example.invalid',
      webUrl: 'https://rezics.example.invalid',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
    });
    expect(await reopened.automaticBackupStatus(instance.id)).toEqual({ state: 'failed', message: first.failure });
    const second = await runWithFailedBackup();
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    await rm(snapshots);
    await rm(saves, { recursive: true });
    await expect(launcher.retryAutomaticBackup(instance.id)).rejects.toThrow('No save folder is available');
    expect(await launcher.lastBackupFailure(instance.id)).toBe(first.failure);
    expect(await reopened.lastBackupFailure(instance.id)).toBe(first.failure);
    await mkdir(saves);
    await writeFile(join(saves, 'checkpoint'), 'saved');
    await launcher.createSnapshot(instance.id, 'Manual checkpoint');
    expect(await launcher.lastBackupFailure(instance.id)).toBe(first.failure);
    const retried = await launcher.retryAutomaticBackup(instance.id);
    expect(retried).toMatchObject({ label: 'Automatic backup', files: 1 });
    expect(await launcher.automaticBackupStatus(instance.id)).toEqual({ state: 'idle' });
    expect(await reopened.automaticBackupStatus(instance.id)).toEqual({ state: 'idle' });
    await writeFile(join(saves, 'checkpoint'), 'new progress');
    await launcher.restoreSnapshot(instance.id, retried.id);
    expect(await readFile(join(saves, 'checkpoint'), 'utf8')).toBe('saved');
  },
);

test('uses a selected world through backup, portable transfer and pre-restore recovery', async () => {
  const { launcher, directory, dataDir } = await fixture();
  const original = await launcher.createMinecraft({ name: 'Source', loader: 'vanilla' });
  const receiving = await launcher.createMinecraft({ name: 'Receiver', loader: 'vanilla' });
  const live = join(dataDir, 'instances', original.id, 'game', 'saves');
  const selected = join(live, 'Chosen world');
  const sibling = join(live, 'Sibling world');
  const exportDir = join(directory, 'portable');
  await Promise.all([mkdir(selected, { recursive: true }), mkdir(sibling, { recursive: true }), mkdir(exportDir)]);
  await writeFile(join(selected, 'level.dat'), 'first');
  await writeFile(join(sibling, 'level.dat'), 'sibling');
  expect((await launcher.listMinecraftWorlds(original.id)).map(({ id }) => id)).toEqual([
    'Chosen world',
    'Sibling world',
  ]);

  const selection = { kind: 'world', id: 'Chosen world' } as const;
  const snapshot = await launcher.createSnapshot(original.id, 'Chosen checkpoint', selection);
  await launcher.setSnapshotPinned(original.id, snapshot.id, true);
  await expect(launcher.deleteSnapshot(original.id, snapshot.id)).rejects.toThrow();
  const bundle = await launcher.exportSnapshot(original.id, snapshot.id, exportDir);
  const imported = await launcher.importSnapshot(receiving.id, bundle);
  expect(imported.selection).toEqual(selection);
  const target = join(dataDir, 'instances', receiving.id, 'game', 'saves', selection.id);
  expect((await launcher.previewRestore(receiving.id, imported.id)).targets[0]?.path).toBe(target);
  await launcher.restoreSnapshot(receiving.id, imported.id);
  expect(await readFile(join(target, 'level.dat'), 'utf8')).toBe('first');

  await writeFile(join(selected, 'level.dat'), 'second');
  await launcher.restoreSnapshot(original.id, snapshot.id);
  expect(await readFile(join(sibling, 'level.dat'), 'utf8')).toBe('sibling');
  expect(await readFile(join(selected, 'level.dat'), 'utf8')).toBe('first');
  const recovery = (await launcher.listSnapshots(original.id)).find(({ label }) => label === 'Before restore');
  expect(recovery?.selection).toEqual(selection);
  expect((await launcher.previewRestore(original.id, recovery!.id)).targets[0]?.path).toBe(selected);
  await launcher.setSnapshotPinned(original.id, snapshot.id, false);
  await launcher.deleteSnapshot(original.id, snapshot.id);
  expect((await launcher.listSnapshots(original.id)).some(({ id }) => id === snapshot.id)).toBe(false);
});

test('finds repeated mod IDs from real files and reads managed and manual ownership without changing them', async () => {
  const { launcher, directory, dataDir } = await fixture();
  const instance = await launcher.createMinecraft({ name: 'Mod folder fixture', loader: 'fabric' });
  const mods = join(dataDir, 'instances', instance.id, 'game', 'mods');
  expect(await launcher.readMinecraftModFolder(instance.id)).toEqual({ exists: false, files: [], duplicates: [] });
  expect(await launcher.minecraftModFolder(instance.id)).toBeNull();
  const source = join(directory, 'source.jar');
  const managed = jar('fixture-mod', '1.0.0');
  await writeFile(source, managed);
  await launcher.importMod(instance.id, source);
  const [managedName] = await readdir(mods);
  const manual = jar('fixture-mod', '2.0.0');
  await mkdir(join(mods, 'nested'));
  await Promise.all([
    writeFile(join(mods, 'manual.jar'), manual),
    writeFile(join(mods, 'broken.jar'), 'not a JAR'),
    writeFile(join(mods, 'inactive.jar.disabled'), manual),
    writeFile(join(mods, 'uppercase.JAR'), manual),
    writeFile(join(mods, '.hidden.jar'), manual),
    writeFile(join(mods, 'nested', 'nested.jar'), manual),
  ]);
  expect(await launcher.minecraftModFolder(instance.id)).toBe(mods);
  const result = await launcher.readMinecraftModFolder(instance.id);
  expect(result.exists).toBeTrue();
  expect(result.files).toHaveLength(6);
  const state = new Map(result.files.map(({ name, owner, state, status }) => [name, [owner, state, status]]));
  expect(state.get(managedName!)).toEqual(['launcher', 'active', 'identified']);
  expect(state.get('manual.jar')).toEqual(['manual', 'active', 'identified']);
  expect(state.get('broken.jar')).toEqual(['manual', 'active', 'unknown']);
  expect(state.get('inactive.jar.disabled')).toEqual(['manual', 'disabled', 'identified']);
  expect(state.get('uppercase.JAR')).toEqual(['manual', 'ignored', 'identified']);
  expect(state.get('.hidden.jar')).toEqual(['manual', 'ignored', 'identified']);
  expect(result.duplicates).toEqual([{ id: 'fixture-mod', files: ['manual.jar', managedName!] }]);
  expect(await readFile(join(mods, 'manual.jar'))).toEqual(manual);
  expect(await readFile(join(mods, managedName!))).toEqual(managed);
  const revision = result.files.find(({ name }) => name === 'manual.jar')?.revision;
  expect(revision).toMatch(/^[0-9a-f]{64}$/u);
  expect(await launcher.setMinecraftManualModEnabled(instance.id, 'manual.jar', false, revision!)).toEqual({
    name: 'manual.jar.disabled',
    enabled: false,
  });
  expect((await launcher.readMinecraftModFolder(instance.id)).duplicates).toEqual([]);
  expect(await readFile(join(mods, 'manual.jar.disabled'))).toEqual(manual);
  expect(await readFile(join(mods, managedName!))).toEqual(managed);
  await writeFile(join(mods, `${managedName}.disabled`), managed);
  const reserved = (await launcher.readMinecraftModFolder(instance.id)).files.find(
    ({ name }) => name === `${managedName}.disabled`,
  );
  expect(reserved?.owner).toBe('launcher');
  expect(reserved?.revision).toBeUndefined();
  await expect(launcher.setMinecraftManualModEnabled(instance.id, reserved!.name, true, revision!)).rejects.toThrow(
    'Use the package controls',
  );
});

test('changes only the reviewed manual JAR and finishes an interrupted name change', async () => {
  const { launcher, dataDir } = await fixture();
  const instance = await launcher.createMinecraft({ name: 'Manual mod fixture', loader: 'fabric' });
  const mods = join(dataDir, 'instances', instance.id, 'game', 'mods');
  const name = 'Local Mod.jar';
  const disabled = `${name}.disabled`;
  const activePath = join(mods, name);
  const disabledPath = join(mods, disabled);
  await mkdir(mods, { recursive: true });
  await writeFile(activePath, 'unreadable JAR');
  const before = await revisionOf(name);
  await writeFile(activePath, 'replacement archive bytes');
  await expect(launcher.setMinecraftManualModEnabled(instance.id, name, false, before)).rejects.toThrow('Rescan Mods');
  const current = await revisionOf(name);
  await expect(launcher.setMinecraftManualModEnabled(instance.id, '../Local Mod.jar', false, current)).rejects.toThrow(
    'Choose an active or disabled JAR',
  );
  await writeFile(disabledPath, 'another disabled file');
  await expect(launcher.setMinecraftManualModEnabled(instance.id, name, false, current)).rejects.toThrow(
    'already uses the destination name',
  );
  expect(await readFile(activePath, 'utf8')).toBe('replacement archive bytes');
  expect(await readFile(disabledPath, 'utf8')).toBe('another disabled file');

  await rm(disabledPath);
  await link(activePath, disabledPath);
  const interrupted = await revisionOf(name);
  expect(await launcher.setMinecraftManualModEnabled(instance.id, name, false, interrupted)).toEqual({
    name: disabled,
    enabled: false,
  });
  expect(await readdir(mods)).toEqual([disabled]);
  const restored = await revisionOf(disabled);
  await launcher.setMinecraftManualModEnabled(instance.id, disabled, true, restored);
  expect(await readdir(mods)).toEqual([name]);
  expect(await readFile(activePath, 'utf8')).toBe('replacement archive bytes');

  async function revisionOf(file: string) {
    const { files } = await launcher.readMinecraftModFolder(instance.id);
    const revision = files.find(({ name }) => name === file)?.revision;
    expect(revision).toMatch(/^[0-9a-f]{64}$/u);
    return revision!;
  }
});

test.skipIf(process.platform === 'win32')('does not inspect linked mod archives or directories', async () => {
  const { launcher, directory, dataDir } = await fixture();
  const instance = await launcher.createMinecraft({ name: 'Linked mod fixture', loader: 'fabric' });
  const mods = join(dataDir, 'instances', instance.id, 'game', 'mods');
  await mkdir(mods, { recursive: true });
  const outside = join(directory, 'other mods');
  await mkdir(outside);
  await writeFile(join(outside, 'source.jar'), jar('fixture-mod', '1.0.0'));
  await symlink(join(outside, 'source.jar'), join(mods, 'linked.jar'));
  expect(await launcher.readMinecraftModFolder(instance.id)).toEqual({
    exists: true,
    files: [{ name: 'linked.jar', owner: 'manual', state: 'active', status: 'linked' }],
    duplicates: [],
  });
  await rm(mods, { recursive: true });
  await symlink(outside, mods, 'dir');
  await expect(launcher.readMinecraftModFolder(instance.id)).rejects.toThrow('The instance mods folder');
  await expect(launcher.minecraftModFolder(instance.id)).rejects.toThrow('The instance mods folder');
});

test('installs exact published artifacts, updates atomically, isolates instances, and toggles a mod', async () => {
  const mod = { id: 'fixture.mod', kind: 'minecraft-mod', title: 'Fixture Mod', summary: '', publisher: 'Fixture' };
  const panel = {
    id: 'fixture.panel',
    kind: 'overlay-panel' as const,
    title: 'Fixture Panel',
    summary: '',
    publisher: 'Fixture',
  };
  const versions: Record<string, Buffer> = {
    one: jar('test-mod', '1.0.0'),
    two: jar('test-mod', '2.0.0'),
    panel: Buffer.from(
      JSON.stringify({ schemaVersion: 1, title: 'Guide', text: 'Open a guide.', destination: 'guide' }),
    ),
  };
  let corrupt = false;
  const fixtureFetch = (async (input: URL) => {
    const url = new URL(input);
    if (url.hostname === 'artifact.example.invalid') {
      const data = versions[url.pathname.slice(1)]!;
      return new Response(new Uint8Array(corrupt ? Buffer.from(data).fill(41) : data));
    }
    const [, , , , packageId, branch, releaseId] = url.pathname.split('/');
    if (!packageId) return Response.json({ items: [panel], nextCursor: null });
    const record = packageId === mod.id ? mod : panel;
    if (branch !== 'releases') return Response.json(record);
    const releases = Object.entries(versions)
      .filter(([id]) => (id === 'panel') === (record.kind === 'overlay-panel'))
      .map(([id, data]) => ({
        id,
        packageId,
        version: id,
        compatibility:
          record.kind === 'overlay-panel'
            ? { kind: record.kind, launcherRange: '>=0.1.0' }
            : { kind: record.kind, loader: 'fabric', gameVersion: '1.21.1' },
        requires: [],
        artifact: { url: `https://artifact.example.invalid/${id}`, size: data.length, sha256: hash(data, 'sha256') },
      }));
    if (releaseId) return Response.json(releases.find(({ id }) => releaseId === id) ?? null);
    return Response.json({ items: releases, nextCursor: null });
  }) as typeof fetch;

  const { launcher, dataDir } = await fixture(fixtureFetch);
  const left = await launcher.createMinecraft({ name: 'Left', loader: 'fabric' });
  const right = await launcher.createMinecraft({ name: 'Right', loader: 'fabric' });
  expect((await launcher.listPackages('overlay-panel')).items).toEqual([panel]);
  expect((await launcher.listReleases(mod.id)).items.map(({ id }) => id)).toEqual(['one', 'two']);
  await launcher.installPackage({ packageId: panel.id, releaseId: 'panel' });
  expect((await launcher.listInstalled())[0]?.id).toBe(panel.id);
  await launcher.installPackage({ packageId: mod.id, releaseId: 'one' }, left.id);
  const folder = join(dataDir, 'instances', left.id, 'game', 'mods');
  const [originalFile] = await readdir(folder);
  expect((await readFile(join(folder, originalFile!))).equals(versions.one!)).toBe(true);

  const replacement = { packageId: mod.id, releaseId: 'two' };
  const { revision } = await launcher.previewCatalogInstall(replacement, left.id);
  const progress: PackageInstallProgress[] = [];
  const review = {
    revision,
    report(value: PackageInstallProgress) {
      progress.push(value);
      throw new Error('Progress observer disconnected.');
    },
  };
  corrupt = true;
  await expect(launcher.installReviewedCatalogPackage(replacement, review, left.id)).rejects.toThrow('digest');
  expect(progress.map(({ phase }) => phase)).toEqual(['checking', 'downloading', 'downloading', 'verifying']);
  const size = versions.two!.length;
  const starting = {
    phase: 'downloading' as const,
    title: mod.title,
    position: 1,
    total: 1,
    bytes: 0,
    totalBytes: size,
  };
  expect(progress[1]).toEqual(starting);
  expect(progress[2]).toEqual({ ...starting, bytes: size });
  expect(progress[3]).toEqual({ ...starting, phase: 'verifying', bytes: size });
  expect((await readFile(join(folder, originalFile!))).equals(versions.one!)).toBe(true);
  expect((await launcher.listInstalled(left.id))[0]?.version).toBe('one');
  expect(await launcher.listInstalled(right.id)).toEqual([]);

  corrupt = false;
  progress.length = 0;
  await launcher.installReviewedCatalogPackage(replacement, review, left.id);
  expect(progress.map(({ phase }) => phase)).toEqual([
    'checking',
    'downloading',
    'downloading',
    'verifying',
    'staging',
    'publishing',
  ]);
  expect((await readFile(join(folder, originalFile!))).equals(versions.two!)).toBe(true);
  await launcher.setPackageEnabled(mod.id, false, left.id);
  expect(await readdir(folder)).toEqual([`${originalFile}.disabled`]);
  const disabled = join(folder, `${originalFile}.disabled`);
  await rm(disabled);
  expect((await launcher.listInstalled(left.id))[0]?.fileIssue).toBe('missing');
  corrupt = true;
  await expect(launcher.repairMod(left.id, mod.id)).rejects.toThrow('digest');
  expect(await readdir(folder)).toEqual([]);
  corrupt = false;
  await launcher.repairMod(left.id, mod.id);
  expect((await readFile(disabled)).equals(versions.two!)).toBe(true);
  await launcher.setPackageEnabled(mod.id, true, left.id);
  expect(await readdir(folder)).toEqual([originalFile!]);
  await launcher.uninstallPackage(mod.id, left.id);
  expect(await readdir(folder)).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'uses an extension edit committed during the startup ledger read in the first game session snapshot',
  async () => {
    const { launcher, directory, dataDir } = await fixture();
    const executable = join(directory, 'fixture');
    await writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    const game = await launcher.importInstance({ kind: 'local', name: 'Fixture', executable });
    const extensions = join(dataDir, 'extensions');
    await mkdir(extensions);
    const entries = ['fixture.disabled', 'fixture.retained'].map((id) => ({
      id,
      title: id,
      version: '1.0.0',
      releaseId: 'guide',
      source: 'rezics',
      enabled: true,
      requires: [],
      conflicts: [],
      panel: { id, title: id, text: 'Guide', destination: 'guide' as const },
    }));
    await writeFile(join(extensions, 'installed.json'), JSON.stringify({ packages: entries }));

    const releaseRead = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<void>();
    const read = InstalledStore.prototype.readCommitted;
    const suspended = spyOn(InstalledStore.prototype, 'readCommitted').mockImplementation(async function (
      this: InstalledStore,
    ) {
      const previous = await read.call(this);
      readStarted.resolve();
      await releaseRead.promise;
      return previous;
    });
    const observed: Session[] = [];
    const detach = launcher.subscribe((session) => {
      if (session) observed.push(session);
    });
    const launching = launcher.launch(game.id);
    try {
      await Promise.race([readStarted.promise, launching]);
      await launcher.setPackageEnabled('fixture.disabled', false);
      expect(await launcher.currentSession()).toBeNull();
      releaseRead.resolve();
      const active = await launching;
      expect(active.panels).toEqual([entries[1]!.panel]);
      expect(observed).toEqual([active]);

      await launcher.setPackageEnabled('fixture.disabled', true);
      expect(await launcher.currentSession()).toEqual({ ...active, panels: entries.map(({ panel }) => panel) });
    } finally {
      releaseRead.resolve();
      const active = await launching.catch(() => undefined);
      detach();
      suspended.mockRestore();
      if (active) await launcher.stopGame(active.sessionId);
    }
  },
);

test('installs and reviews changes to a transitive Modrinth dependency graph', async () => {
  const mods: Record<string, { packageId: string; data: Buffer; requires: unknown[] }> = {
    initial: {
      packageId: 'feature',
      data: jar('fixture-feature', '1.0.0'),
      requires: [{ project_id: 'bridge', version_id: 'middle', dependency_type: 'required' }],
    },
    middle: {
      packageId: 'bridge',
      data: jar('fixture-bridge', '1.0.0'),
      requires: [{ project_id: 'support', version_id: 'dependency', dependency_type: 'required' }],
    },
    dependency: { packageId: 'support', data: jar('fixture-support', '1.0.0'), requires: [] },
    independent: { packageId: 'independent', data: jar('fixture-independent', '1.0.0'), requires: [] },
    addon: {
      packageId: 'addon',
      data: jar('fixture-addon', '1.0.0'),
      requires: [{ project_id: 'feature', version_id: null, dependency_type: 'required' }],
    },
  };
  const downloads: string[] = [];
  let onAddonDownload: (() => Promise<void>) | undefined;
  const fixtureFetch = (async (input: URL) => {
    const url = new URL(input);
    const version = url.pathname.split('/').at(-1)!;
    const mod = mods[version];
    if (!mod) return new Response(null, { status: 404 });
    if (url.hostname === 'artifact.example.invalid') {
      downloads.push(version);
      if (version === 'addon') await onAddonDownload?.();
      return new Response(new Uint8Array(mod.data));
    }
    return Response.json({
      id: version,
      project_id: mod.packageId,
      name: mod.packageId,
      version_number: '1.0.0',
      version_type: 'release',
      game_versions: ['1.21.1'],
      loaders: ['fabric'],
      dependencies: mod.requires,
      files: [
        {
          primary: true,
          filename: 'fixture.jar',
          url: `https://artifact.example.invalid/${version}`,
          size: mod.data.length,
          hashes: { sha512: hash(mod.data, 'sha512') },
        },
      ],
    });
  }) as typeof fetch;
  const { launcher, dataDir } = await fixture(fixtureFetch);
  const game = await launcher.createMinecraft({ name: 'Fabric fixture', loader: 'fabric' });
  await launcher.installMod(game.id, 'initial');
  const support = 'modrinth:support';
  const bridge = 'modrinth:bridge';
  const feature = 'modrinth:feature';
  expect((await launcher.listInstalled(game.id)).map(({ id }) => id)).toEqual([support, bridge, feature]);
  const folder = join(dataDir, 'instances', game.id, 'game', 'mods');
  const path = (id: string) => join(folder, `rezics-${createHash('sha256').update(id).digest('hex')}.jar`);
  const readStates = async () => (await launcher.listInstalled(game.id)).map(({ enabled }) => enabled);
  const beforeAddon = (await readdir(folder)).sort();
  const addon = await launcher.previewModInstall(game.id, 'addon');
  expect(addon.changes.map(({ id }) => id)).toEqual(['addon']);

  const corrupted = Buffer.alloc(mods.dependency!.data.length);
  await writeFile(path(support), corrupted);
  await expect(launcher.previewModInstall(game.id, 'addon')).rejects.toThrow('Repair support');
  await expect(launcher.installMod(game.id, 'addon', addon.revision)).rejects.toThrow('Repair support');
  expect(downloads).toEqual(['dependency', 'middle', 'initial']);

  await launcher.repairMod(game.id, support);
  const repaired = await launcher.previewModInstall(game.id, 'addon');
  onAddonDownload = () => writeFile(path(support), corrupted);
  await expect(launcher.installMod(game.id, 'addon', repaired.revision)).rejects.toThrow('Repair support');
  expect((await readdir(folder)).sort()).toEqual(beforeAddon);
  onAddonDownload = undefined;
  await launcher.repairMod(game.id, support);
  const retry = await launcher.previewModInstall(game.id, 'addon');
  await launcher.installMod(game.id, 'addon', retry.revision);
  await launcher.uninstallPackage('modrinth:addon', game.id);

  expect(await readdir(folder)).toHaveLength(3);
  await expect(launcher.uninstallPackage(support, game.id)).rejects.toThrow('requires modrinth:support');

  const stale = await launcher.previewModState(game.id, support, false);
  expect(stale.changes.map(({ id }) => id)).toEqual([support, bridge, feature]);
  expect(await readStates()).toEqual([true, true, true]);
  await launcher.installMod(game.id, 'independent');
  await expect(launcher.applyModState(game.id, support, false, stale.revision)).rejects.toThrow(
    'Review the mod change again',
  );

  const current = await launcher.previewModState(game.id, support, false);
  const disabledSupport = `${path(support)}.disabled`;
  await writeFile(disabledSupport, 'unmanaged occupant');
  await expect(launcher.applyModState(game.id, support, false, current.revision)).rejects.toThrow('An unmanaged file');
  expect(await readStates()).toEqual([true, true, true, true]);
  expect(await readFile(disabledSupport, 'utf8')).toBe('unmanaged occupant');
  await rm(disabledSupport);

  await launcher.applyModState(game.id, support, false, current.revision);
  expect(await readStates()).toEqual([false, false, false, true]);
  const independent = await readFile(path('modrinth:independent'));
  const enable = await launcher.previewModState(game.id, feature, true);
  expect(enable.changes.map(({ id }) => id)).toEqual([feature, bridge, support]);
  const originalSupport = await readFile(disabledSupport);
  await writeFile(disabledSupport, Buffer.alloc(originalSupport.length));
  await expect(launcher.applyModState(game.id, feature, true, enable.revision)).rejects.toThrow('Repair support');
  expect(await readStates()).toEqual([false, false, false, true]);
  await writeFile(disabledSupport, originalSupport);
  await launcher.applyModState(game.id, feature, true, enable.revision);
  expect(await readStates()).toEqual([true, true, true, true]);
  expect(await readFile(path(support))).toEqual(originalSupport);
  expect(await readFile(path('modrinth:independent'))).toEqual(independent);
  await launcher.uninstallPackage('modrinth:feature', game.id);
  await launcher.uninstallPackage('modrinth:bridge', game.id);
  await launcher.uninstallPackage('modrinth:support', game.id);
  await launcher.uninstallPackage('modrinth:independent', game.id);
  expect(await launcher.listInstalled(game.id)).toEqual([]);
});
