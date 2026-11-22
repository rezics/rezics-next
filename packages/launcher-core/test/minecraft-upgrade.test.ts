import type { MinecraftPreparation, MinecraftSelection } from '@rezics/launcher-contract';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { createLauncher, type Launcher } from '../src/index.ts';
import { Instances } from '../src/instances.ts';
import { Minecraft } from '../src/minecraft.ts';
import { Saves } from '../src/saves.ts';
import { fileInfo, writeJson } from '../src/storage.ts';
import { levelSavedIn } from './fixtures/minecraft-level.ts';

const temporary = fileURLToPath(new URL('../.temp/', import.meta.url));
const directories: string[] = [];
const original = { version: '1.21.1', loader: 'fabric', fabricVersion: '0.16.14' } as const;
const upgrade = { version: '1.21.2', loader: 'vanilla' } as const;
const downgrade = { version: '1.20.1', loader: 'vanilla' } as const;
const oldInstallation = { versionId: 'old-playable', javaRuntime: 'fixture-runtime', javaMajor: 21 };
const candidateInstallation = { versionId: 'verified-candidate', javaRuntime: 'fixture-runtime', javaMajor: 21 };
const settings = { java: { kind: 'managed' }, maxMemoryMiB: 4096 } as const;

async function put(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function fixture() {
  await mkdir(temporary, { recursive: true });
  const dataDir = await mkdtemp(join(temporary, 'minecraft-upgrade-'));
  directories.push(dataDir);
  const restart = () =>
    createLauncher({
      dataDir,
      catalogUrl: 'https://catalog.example.invalid',
      webUrl: 'https://site.example.invalid',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
      fetch: (async (input: string | URL) => {
        if (new URL(input).hostname !== 'piston-meta.mojang.com') throw new Error('unexpected network');
        return Response.json({
          versions: [original.version, upgrade.version, downgrade.version].map((id) => ({
            id,
            type: 'release',
            url: `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`,
          })),
        });
      }) as typeof fetch,
    });
  const launcher = restart();
  const instance = await launcher.createMinecraft({ name: 'Original', ...original });
  const instances = new Instances(dataDir);
  const initial = {
    id: instance.id,
    name: instance.name,
    kind: 'minecraft' as const,
    minecraft: { ...original, settings, prepared: true },
    installation: oldInstallation,
  };
  await instances.write(initial);
  const home = instances.directory(instance.id);
  const game = instances.gamePath(instance.id);
  const world = join(game, 'saves', 'Original World', 'level.dat');
  await put(world, 'live world bytes');
  return { launcher, restart, instances, initial, home, game, world };
}

async function finished(launcher: Launcher, id: string) {
  const deadline = AbortSignal.timeout(3000);
  while (true) {
    const status = await launcher.readMinecraftPreparation(id);
    if (status && !['running', 'cancelling'].includes(status.state)) return status;
    await setTimeout(5, undefined, { signal: deadline });
  }
}

async function pack(path: string) {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Original Pack',
        versionId: 'pack-one',
        files: [],
        dependencies: { minecraft: original.version, 'fabric-loader': original.fabricVersion },
      }),
    ),
    'modrinth.index.json',
  );
  zip.addBuffer(Buffer.from('pack-installed config'), 'overrides/config/pack.txt');
  const output = pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx' }));
  zip.end();
  await output;
}

afterEach(async () => {
  mock.restore();
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('uses the selected Java for the destination and retains the original instance on a copy', async () => {
  const { launcher, restart, instances, initial, game, world } = await fixture();
  const custom = { kind: 'custom', executable: join(game, 'jdk', 'bin', 'java') } as const;
  const originalRecord = { ...initial, minecraft: { ...initial.minecraft, settings: { ...settings, java: custom } } };
  await instances.write(originalRecord);
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async ({ settings }) => {
    if (settings?.java.kind !== 'managed') throw new Error('This Minecraft release requires Java 17.');
    return { ...candidateInstallation, javaMajor: 17 };
  });
  const targetJava = { kind: 'managed' } as const;
  const selected = ['Original World'];

  prepare.mockRejectedValueOnce(new Error('Java download was interrupted.'));
  await launcher.startMinecraftUpgrade(initial.id, downgrade, 'copy', selected, undefined, targetJava);
  const failed = await finished(launcher, initial.id);
  expect(failed).toMatchObject({ state: 'failed', java: targetJava, worldIds: selected });
  expect(prepare.mock.calls[0]?.[0].settings).toEqual({ ...settings, java: targetJava });
  expect(await instances.find(initial.id)).toEqual(originalRecord);
  expect(await launcher.listInstances()).toHaveLength(1);

  const reopened = restart();
  const saved = await reopened.readMinecraftPreparation(initial.id);
  expect(saved).toEqual(failed);
  await reopened.startMinecraftUpgrade(initial.id, downgrade, 'copy', selected, undefined, saved?.java);
  const copy = await finished(reopened, initial.id);
  expect(copy).toMatchObject({ state: 'ready', java: targetJava, worldIds: selected });
  expect(await instances.find(copy.resultInstanceId!)).toMatchObject({
    minecraft: { ...downgrade, settings, prepared: true },
    installation: { javaMajor: 17 },
  });
  expect(await instances.find(initial.id)).toEqual(originalRecord);
  expect(
    await readFile(join(instances.gamePath(copy.resultInstanceId!), 'saves', 'Original World', 'level.dat'), 'utf8'),
  ).toBe(await readFile(world, 'utf8'));

  const destinationJava = { kind: 'custom', executable: join(game, 'jdk-21', 'bin', 'java') } as const;
  prepare.mockResolvedValueOnce({ versionId: 'custom-candidate', javaMajor: 21 });
  await reopened.startMinecraftUpgrade(initial.id, upgrade, 'in-place', undefined, undefined, destinationJava);
  expect(await finished(reopened, initial.id)).toMatchObject({ state: 'ready', java: destinationJava });
  expect(prepare.mock.calls.at(-1)?.[0].settings).toEqual({ ...settings, java: destinationJava });
  expect(await instances.find(initial.id)).toMatchObject({
    minecraft: { ...upgrade, settings: { ...settings, java: destinationJava }, prepared: true },
    installation: { versionId: 'custom-candidate' },
  });
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
});

test('requires a separate downgrade for existing worlds and rechecks before publishing in place', async () => {
  const { launcher, instances, initial, game, world } = await fixture();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue(candidateInstallation);
  const keepWorlds = 'Prepare a downgraded copy to keep them with the original version.';

  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, downgrade.version)).toBe('worlds');
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, upgrade.version)).toBeNull();
  await launcher.startMinecraftUpgrade(initial.id, downgrade, 'in-place');
  const blocked = await finished(launcher, initial.id);
  expect(blocked).toMatchObject({ state: 'failed', phase: 'version' });
  expect(blocked.error).toContain(keepWorlds);
  expect(prepare).not.toHaveBeenCalled();

  await launcher.startMinecraftUpgrade(initial.id, downgrade, 'copy', []);
  const copy = await finished(launcher, initial.id);
  expect(copy).toMatchObject({ state: 'ready', worldIds: [] });
  const result = (await launcher.listInstances()).find(({ id }) => id === copy.resultInstanceId);
  expect(result).toMatchObject({ name: 'Original (downgraded copy)', minecraft: { ...downgrade, prepared: true } });
  expect(await launcher.listMinecraftWorlds(result!.id)).toEqual([]);
  expect(await readFile(world, 'utf8')).toBe('live world bytes');

  await rm(join(game, 'saves'), { recursive: true });
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, downgrade.version)).toBeNull();
  prepare.mockImplementationOnce(async () => {
    await put(world, 'world appeared during preparation');
    return candidateInstallation;
  });
  await launcher.startMinecraftUpgrade(initial.id, downgrade, 'in-place');
  const late = await finished(launcher, initial.id);
  expect(late).toMatchObject({ state: 'failed', phase: 'worlds' });
  expect(late.error).toContain(keepWorlds);
  expect(await instances.find(initial.id)).toEqual(initial);
  expect(await readFile(world, 'utf8')).toBe('world appeared during preparation');
  expect(await launcher.listSnapshots(initial.id)).toEqual([]);

  await rm(join(game, 'saves'), { recursive: true });
  await launcher.startMinecraftUpgrade(initial.id, downgrade, 'in-place');
  expect(await finished(launcher, initial.id)).toMatchObject({ state: 'ready', resultInstanceId: initial.id });
  expect(await instances.find(initial.id)).toMatchObject({ minecraft: { ...downgrade, prepared: true } });
});

test('blocks an in-place upgrade for a newer world and rechecks world copy approval before publication', async () => {
  const { launcher, instances, initial, game, world } = await fixture();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue(candidateInstallation);
  const chosen = ['Original World'];
  const sibling = join(game, 'saves', 'Older World', 'level.dat');
  await put(sibling, 'independent world');
  await writeFile(world, levelSavedIn('26.3'));
  const approved = { worldVersion: '26.3', targetVersion: upgrade.version };
  expect(await launcher.previewMinecraftWorldCopy(initial.id, upgrade.version)).toEqual(approved);
  expect(await launcher.previewMinecraftWorldCopy(initial.id, upgrade.version, ['Older World'])).toBeNull();
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, upgrade.version)).toBe('newer-worlds');
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  expect(await finished(launcher, initial.id)).toMatchObject({ state: 'failed', phase: 'version' });
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', chosen);
  expect(await finished(launcher, initial.id)).toMatchObject({ state: 'failed', phase: 'version' });
  expect(prepare).not.toHaveBeenCalled();

  const changed = levelSavedIn('26.3.1');
  prepare.mockImplementationOnce(async () => {
    await writeFile(world, changed);
    return candidateInstallation;
  });
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', chosen, approved);
  expect(await finished(launcher, initial.id)).toMatchObject({ state: 'failed', phase: 'worlds' });
  expect((await launcher.listInstances()).map(({ id }) => id)).toEqual([initial.id]);
  expect(await launcher.listSnapshots(initial.id)).toEqual([]);

  const reviewed = await launcher.previewMinecraftWorldCopy(initial.id, upgrade.version, chosen);
  expect(reviewed).toEqual({ worldVersion: '26.3.1', targetVersion: upgrade.version });
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', chosen, reviewed!);
  const copy = await finished(launcher, initial.id);
  expect(copy).toMatchObject({ state: 'ready', worldIds: chosen });
  const path = join(instances.gamePath(copy.resultInstanceId!), 'saves', chosen[0]!, 'level.dat');
  expect(await readFile(path)).toEqual(changed);
  expect(await launcher.listMinecraftWorlds(copy.resultInstanceId!)).toEqual([{ id: chosen[0]!, name: chosen[0]! }]);
  expect(await instances.find(initial.id)).toEqual(initial);
  expect(await readFile(world)).toEqual(changed);
  expect(await readFile(sibling, 'utf8')).toBe('independent world');
});

test('prepares a candidate and backs up the old worlds before atomically changing the exact instance', async () => {
  const { launcher, restart, instances, initial, home, world } = await fixture();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async (selection, job) => {
    expect(selection).toMatchObject({ ...upgrade, settings });
    expect(job.mode).toBe('upgrade');
    expect(await instances.find(initial.id)).toEqual(initial);
    return candidateInstallation;
  });
  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  expect(attempt).toMatchObject({ mode: 'upgrade', selection: upgrade, upgradeMode: 'in-place', state: 'running' });
  const completed = await finished(launcher, initial.id);
  expect(completed).toMatchObject({ state: 'ready', resultInstanceId: initial.id });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await instances.find(initial.id)).toMatchObject({
    ...initial,
    minecraft: { ...upgrade, settings, prepared: true },
    installation: candidateInstallation,
  });
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
  const snapshots = await launcher.listSnapshots(initial.id);
  expect(snapshots).toEqual([
    expect.objectContaining({
      minecraft: {
        version: original.version,
        loader: original.loader,
        loaderVersion: original.fabricVersion,
        mods: [],
      },
      label: 'Before Minecraft version or loader change',
    }),
  ]);
  expect(
    await readFile(join(home, 'snapshots', snapshots[0]!.id, 'worlds', 'Original World', 'level.dat'), 'utf8'),
  ).toBe('live world bytes');

  await writeJson(join(home, 'instance.json'), {
    ...(await instances.find(initial.id)),
    lastPreparationId: undefined,
    lastUpgradeId: attempt.id,
  });
  await writeJson(join(home, 'minecraft-preparation.json'), { ...attempt, phase: 'verify', cancellable: false });
  expect(await restart().readMinecraftPreparation(initial.id)).toMatchObject({
    id: attempt.id,
    state: 'ready',
    resultInstanceId: initial.id,
  });
  await expect(launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place')).rejects.toThrow(
    'different Minecraft release or loader',
  );
});

test('upgraded copy publishes selected worlds and settings while other worlds, mods and the pack stay on the original', async () => {
  const { launcher, restart, instances, initial, home, game, world } = await fixture();
  const source = join(home, 'fixture.mrpack');
  await pack(source);
  const { digest, preview } = await launcher.inspectModrinthPack(source);
  await launcher.importModrinthPack(source, digest, preview, initial.id);
  const ledger = join(home, 'installed-mods', 'installed.json');
  await writeJson(ledger, { packages: [{ id: 'disabled-mod', enabled: false }] });
  await put(join(game, 'mods', 'unmanaged.jar'), 'original mod');
  await put(join(game, 'saves', 'Original World', 'session.lock'), 'stale lock');
  const otherWorld = join(game, 'saves', 'Other World', 'level.dat');
  await put(otherWorld, 'other world bytes');
  const oldLedger = await readFile(ledger, 'utf8');
  const record = join(home, 'instance.json');
  const originalBytes = await readFile(record, 'utf8');
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue(candidateInstallation);

  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('has a modpack'),
  });
  expect(prepare).not.toHaveBeenCalled();
  const worldIds = ['Original World'];
  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', worldIds);
  const completed = await finished(launcher, initial.id);
  expect(completed).toMatchObject({ state: 'ready', resultInstanceId: `game-${attempt.id}`, worldIds });
  const copyId = completed.resultInstanceId!;

  expect(await instances.find(copyId)).toMatchObject({
    minecraft: { ...upgrade, prepared: true, settings },
    installation: candidateInstallation,
  });
  const copiedWorld = join(instances.gamePath(copyId), 'saves', 'Original World', 'level.dat');
  expect(await readFile(copiedWorld, 'utf8')).toBe('live world bytes');
  await writeFile(copiedWorld, 'changed copy only');
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
  expect(await readFile(otherWorld, 'utf8')).toBe('other world bytes');
  expect(await readdir(join(instances.gamePath(copyId), 'saves'))).toEqual(worldIds);
  expect(await fileInfo(join(instances.gamePath(copyId), 'saves', 'Original World', 'session.lock'))).toBeUndefined();
  expect(await fileInfo(join(instances.gamePath(copyId), 'mods'))).toBeUndefined();
  expect(await fileInfo(join(instances.gamePath(copyId), 'config'))).toBeUndefined();
  expect(await launcher.currentModrinthPack(copyId)).toBeNull();
  expect(await launcher.currentModrinthPack(initial.id)).toEqual(preview);
  expect(await readFile(ledger, 'utf8')).toBe(oldLedger);
  expect(await readFile(join(game, 'mods', 'unmanaged.jar'), 'utf8')).toBe('original mod');
  expect(await readFile(record, 'utf8')).toBe(originalBytes);

  await writeJson(join(home, 'minecraft-preparation.json'), { ...attempt, phase: 'verify', cancellable: false });
  expect(await restart().readMinecraftPreparation(initial.id)).toMatchObject({
    id: attempt.id,
    state: 'ready',
    resultInstanceId: copyId,
    worldIds,
  });
});

test('in-place change protects unmanaged nested JARs and an installed pack independently', async () => {
  const { launcher, initial, home, game } = await fixture();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue(candidateInstallation);
  const untracked = join(game, 'mods', 'nested', 'manual.JAR.disabled');
  await expect(launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, 'latest')).rejects.toThrow('exact');
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, upgrade.version)).toBeNull();
  await put(untracked, 'unmanaged');
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, upgrade.version)).toBe('mods');
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('has mods'),
  });
  expect(await readFile(untracked, 'utf8')).toBe('unmanaged');
  await rm(untracked);

  const source = join(home, 'fixture.mrpack');
  await pack(source);
  const { digest, preview } = await launcher.inspectModrinthPack(source);
  await launcher.importModrinthPack(source, digest, preview, initial.id);
  expect(await launcher.readMinecraftInPlaceUpgradeBlocker(initial.id, upgrade.version)).toBe('modpack');
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('has a modpack'),
  });
  expect(await launcher.currentModrinthPack(initial.id)).toEqual(preview);
  expect(prepare).not.toHaveBeenCalled();
});

test('failure, stale overlapping start and cancellation during world backup retain the old installation and hold the instance lock', async () => {
  const { launcher, restart, instances, initial, home, world } = await fixture();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockRejectedValueOnce(
    new Error('This Minecraft release requires Java 25.'),
  );
  await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy');
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('requires Java 25'),
  });
  expect(await launcher.listInstances()).toHaveLength(1);
  expect(await instances.find(initial.id)).toEqual(initial);

  prepare.mockResolvedValue(candidateInstallation);
  const makingBackup = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  spyOn(Saves.prototype, 'create').mockImplementation(async (_roots, _context, _label, _selection, signal) => {
    signal!.addEventListener('abort', () => cancelled.resolve(), { once: true });
    makingBackup.resolve();
    await drained.promise;
    signal!.throwIfAborted();
    throw new Error('The fixture must cancel the backup.');
  });
  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place');
  await makingBackup.promise;
  expect(await launcher.readMinecraftPreparation(initial.id)).toMatchObject({ phase: 'worlds', state: 'running' });
  const stale = { version: '1.21.1', loader: 'vanilla' } as MinecraftSelection;
  await expect(launcher.startMinecraftUpgrade(initial.id, stale, 'copy')).rejects.toThrow(
    'current Minecraft preparation',
  );
  await expect(launcher.startMinecraftPreparation(initial.id, 'repair')).rejects.toThrow('current Minecraft change');
  const edit = launcher.renameMinecraft(initial.id, 'Updated name only');
  expect(await launcher.cancelMinecraftPreparation(initial.id)).toMatchObject({ state: 'cancelling' });
  await cancelled.promise;
  expect(await instances.find(initial.id)).toEqual(initial);
  drained.resolve();
  expect(await finished(launcher, initial.id)).toMatchObject({ state: 'cancelled' });
  expect(await edit).toMatchObject({ name: 'Updated name only', minecraft: initial.minecraft });
  expect(await instances.find(initial.id)).toMatchObject({ installation: oldInstallation });
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
  expect(await launcher.listSnapshots(initial.id)).toEqual([]);

  const interrupted: MinecraftPreparation = { ...attempt, phase: 'verify', cancellable: false };
  await writeJson(join(home, 'minecraft-preparation.json'), interrupted);
  expect(await restart().readMinecraftPreparation(initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('closed before preparation'),
  });
  expect((await readdir(dirname(home))).filter((name) => name.startsWith('game-'))).toHaveLength(1);
});

test('records the terminal upgrade before releasing the lock to a queued archive operation', async () => {
  const { launcher, initial, home } = await fixture();
  const verifying = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  spyOn(Minecraft.prototype, 'prepare').mockImplementation(async () => {
    verifying.resolve();
    await finish.promise;
    return candidateInstallation;
  });
  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy');
  await verifying.promise;
  const archive = launcher.archiveMinecraft(initial.id);
  finish.resolve();
  await archive;
  expect(await fileInfo(home)).toBeUndefined();
  const archived = join(dirname(home), '.archive', initial.id, 'minecraft-preparation.json');
  expect(JSON.parse(await readFile(archived, 'utf8'))).toMatchObject({
    id: attempt.id,
    state: 'ready',
    resultInstanceId: `game-${attempt.id}`,
  });
  await launcher.restoreArchivedMinecraft(initial.id);
  expect(await launcher.readMinecraftPreparation(initial.id)).toMatchObject({ state: 'ready' });
  expect(await launcher.listMinecraftWorlds(`game-${attempt.id}`)).toMatchObject([{ id: 'Original World' }]);
});

test('refuses to publish an upgraded copy with a linked world and reclaims its draft', async () => {
  const { launcher, instances, initial, home, game, world } = await fixture();
  const external = join(home, 'external-fixture');
  const externalData = join(external, 'level.dat');
  await put(externalData, 'unrelated world bytes');
  await symlink(external, join(game, 'saves', 'Linked World'), 'junction');
  spyOn(Minecraft.prototype, 'prepare').mockResolvedValue(candidateInstallation);

  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy');
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('contains a link'),
  });
  expect(await instances.find(initial.id)).toEqual(initial);
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
  expect(await readFile(externalData, 'utf8')).toBe('unrelated world bytes');
  expect(await fileInfo(join(dirname(home), '.duplicate-staging', `game-${attempt.id}`))).toBeUndefined();
  expect(await launcher.listInstances()).toHaveLength(1);

  const blank = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', []);
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'ready',
    resultInstanceId: `game-${blank.id}`,
    worldIds: [],
  });
  expect(await launcher.listMinecraftWorlds(`game-${blank.id}`)).toEqual([]);
  expect(await readFile(world, 'utf8')).toBe('live world bytes');
  expect(await readFile(externalData, 'utf8')).toBe('unrelated world bytes');
});

test('revalidates selected world identity before publication and records the request across restart', async () => {
  const { launcher, restart, initial, home, world } = await fixture();
  const verifying = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async () => {
    verifying.resolve();
    await finish.promise;
    return candidateInstallation;
  });
  await expect(launcher.startMinecraftUpgrade(initial.id, upgrade, 'in-place', [])).rejects.toThrow(
    'separate instance',
  );
  await expect(launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', ['../other'])).rejects.toThrow(
    'valid Minecraft world',
  );
  await expect(launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', ['World', 'world'])).rejects.toThrow(
    'conflicting names',
  );
  expect(prepare).not.toHaveBeenCalled();

  const worldIds = ['Original World'];
  const attempt = await launcher.startMinecraftUpgrade(initial.id, upgrade, 'copy', worldIds);
  const relocated = join(home, 'relocated-world');
  await verifying.promise;
  try {
    await rename(dirname(world), relocated);
    await put(world, 'replacement world bytes');
  } finally {
    finish.resolve();
  }
  expect(await finished(launcher, initial.id)).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('selected Minecraft world changed'),
  });
  expect(await restart().readMinecraftPreparation(initial.id)).toMatchObject({
    id: attempt.id,
    state: 'failed',
    worldIds,
  });
  expect(await launcher.listInstances()).toHaveLength(1);
  expect(await readFile(world, 'utf8')).toBe('replacement world bytes');
  expect(await readFile(join(relocated, 'level.dat'), 'utf8')).toBe('live world bytes');
  expect(await fileInfo(join(dirname(home), '.duplicate-staging', `game-${attempt.id}`))).toBeUndefined();
});
