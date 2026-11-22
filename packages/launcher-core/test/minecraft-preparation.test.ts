import type { MinecraftPreparation } from '@rezics/launcher-contract';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createLauncher } from '../src/index.ts';
import { Minecraft } from '../src/minecraft.ts';
import { createMinecraftPreparation } from '../src/plugins/minecraft-preparation.ts';
import { Locks, writeJson } from '../src/storage.ts';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rezics-minecraft-preparation-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test('keeps cancellation active until the owning lock is released and retries interrupted preparation', async () => {
  const directory = await fixture();
  const instanceId = 'instance';
  const lock = new Locks();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const committing = Promise.withResolvers<void>();
  const persisted = Promise.withResolvers<void>();
  const instance = join(directory, 'instance.json');
  await writeFile(instance, 'previous verified installation');

  const create = () =>
    createMinecraftPreparation({
      directory: () => directory,
      prepare: (_id, job) =>
        lock.run('instance', async () => {
          if (job.mode === 'install') {
            job.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
            await job.report('assets', { completed: 32, total: 65 });
            entered.resolve();
            await drained.promise;
            job.signal.throwIfAborted();
          }
          await job.report('assets', { completed: 65, total: 65 });
          await job.commit(async () => {
            committing.resolve();
            await persisted.promise;
            await writeFile(instance, 'repaired installation');
          });
        }),
    });
  const preparation = create();
  const started = await preparation.start(instanceId, 'install');
  await entered.promise;
  expect(await preparation.start(instanceId, 'repair')).toMatchObject({ id: started.id, mode: 'install' });
  expect(await preparation.read(instanceId)).toMatchObject({
    state: 'running',
    phase: 'assets',
    progress: { completed: 32, total: 65 },
  });
  expect(await preparation.cancel(instanceId)).toMatchObject({ state: 'cancelling', cancellable: false });
  await cancelled.promise;
  const afterLock = lock.run('instance', () => readFile(instance, 'utf8'));
  expect(await preparation.read(instanceId)).toMatchObject({ state: 'cancelling' });
  drained.resolve();
  expect(await afterLock).toBe('previous verified installation');
  expect(await preparation.wait(instanceId)).toMatchObject({
    state: 'cancelled',
    phase: 'assets',
    progress: { completed: 32, total: 65 },
  });

  const interrupted: MinecraftPreparation = { ...started, state: 'running', phase: 'java' };
  await writeJson(join(directory, 'minecraft-preparation.json'), interrupted);
  const restarted = create();
  expect(await restarted.read(instanceId)).toMatchObject({ state: 'failed', phase: 'java' });
  expect(await readFile(instance, 'utf8')).toBe('previous verified installation');
  const repair = await restarted.start(instanceId, 'repair');
  expect(repair.id).not.toBe(started.id);
  await committing.promise;
  const committingStatus = await restarted.cancel(instanceId);
  expect(committingStatus).toMatchObject({ state: 'running', phase: 'verify', cancellable: false });
  expect(committingStatus).not.toHaveProperty('progress');
  persisted.resolve();
  expect(await restarted.wait(instanceId)).toMatchObject({ id: repair.id, mode: 'repair', state: 'ready' });
  expect(await create().read(instanceId)).toMatchObject({ id: repair.id, state: 'ready' });
  expect(await readFile(instance, 'utf8')).toBe('repaired installation');
});

test('publishes preparation changes and cancels the exact queued job before shared files are released', async () => {
  const directory = await fixture();
  const launcher = createLauncher({
    dataDir: directory,
    catalogUrl: 'https://catalog.test',
    webUrl: 'https://web.test',
    launcherVersion: '1.0.0',
    openExternal: async () => {},
  });
  const holder = await launcher.createMinecraft({ name: 'Preparing', loader: 'vanilla' });
  const waiting = await launcher.createMinecraft({ name: 'Waiting', loader: 'vanilla' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async (selection, job) => {
    await job.report('libraries');
    entered.resolve();
    await release.promise;
    job.signal.throwIfAborted();
    return { versionId: selection.version };
  });
  const events: MinecraftPreparation[] = [];
  const cancelled = Promise.withResolvers<MinecraftPreparation>();
  const stop = launcher.subscribeMinecraftPreparation((attempt) => {
    events.push(attempt);
    if (attempt.instanceId === waiting.id && attempt.state === 'cancelled') cancelled.resolve(attempt);
  });
  const ready = Promise.withResolvers<void>();
  const observeReady = launcher.subscribeMinecraftPreparation((attempt) => {
    if (attempt.instanceId === waiting.id && attempt.state === 'ready') ready.resolve();
  });
  try {
    expect(await launcher.activeMinecraftPreparations()).toEqual([]);
    const first = await launcher.startMinecraftPreparation(holder.id, 'install');
    await entered.promise;
    const queued = await launcher.startMinecraftPreparation(waiting.id, 'install');
    expect(await launcher.activeMinecraftPreparations()).toMatchObject([
      { id: first.id, phase: 'libraries' },
      { id: queued.id, phase: 'queued' },
    ]);
    await expect(launcher.launch(holder.id)).rejects.toThrow('Wait for Minecraft preparation');
    await expect(launcher.launch(waiting.id)).rejects.toThrow('Wait for Minecraft preparation');
    expect(await launcher.cancelMinecraftPreparation(waiting.id, first.id)).toMatchObject({
      id: queued.id,
      state: 'running',
    });
    expect(await launcher.cancelMinecraftPreparation(waiting.id, queued.id)).toMatchObject({ state: 'cancelling' });
    expect(await cancelled.promise).toMatchObject({ id: queued.id, phase: 'queued' });
    expect(await launcher.activeMinecraftPreparations()).toMatchObject([{ id: first.id }]);
    expect(prepare).toHaveBeenCalledTimes(1);
    const retry = await launcher.startMinecraftPreparation(waiting.id, 'install');
    expect(retry.id).not.toBe(queued.id);
    expect(await launcher.cancelMinecraftPreparation(waiting.id, queued.id)).toMatchObject({ state: 'running' });
    release.resolve();
    await ready.promise;
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(await launcher.activeMinecraftPreparations()).toEqual([]);
    expect(events.filter((event) => event.id === queued.id).map((event) => event.state)).toEqual([
      'running',
      'cancelling',
      'cancelled',
    ]);
  } finally {
    release.resolve();
    stop();
    observeReady();
    prepare.mockRestore();
  }
});

test('recovers committed installs and repairs and lists only unfinished work after restart', async () => {
  const directory = await fixture();
  const restart = () =>
    createLauncher({
      dataDir: directory,
      catalogUrl: 'https://catalog.test',
      webUrl: 'https://web.test',
      launcherVersion: '1.0.0',
      openExternal: async () => {},
    });
  const launcher = restart();
  const game = await launcher.createMinecraft({ name: 'Recovery', loader: 'vanilla' });
  const path = join(directory, 'instances', game.id, 'minecraft-preparation.json');
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue({ versionId: 'verified', javaMajor: 21 });
  try {
    await launcher.prepareMinecraft(game.id);
    const install = (await launcher.readMinecraftPreparation(game.id))!;
    const committing = { ...install, state: 'running', phase: 'verify', cancellable: false } as const;
    await writeJson(path, committing);
    expect(await restart().readMinecraftPreparation(game.id)).toEqual(expect.objectContaining({ state: 'ready' }));

    const missed = { ...committing, mode: 'repair', id: randomUUID() } as const;
    await writeJson(path, missed);
    expect(await restart().readMinecraftPreparationActivity()).toEqual([
      expect.objectContaining({ id: missed.id, state: 'failed', interrupted: true }),
    ]);
    expect(await restart().readMinecraftPreparationActivity()).toHaveLength(1);

    const done = Promise.withResolvers<MinecraftPreparation>();
    const stop = launcher.subscribeMinecraftPreparation((attempt) => {
      if (attempt.mode === 'repair' && attempt.state === 'ready') done.resolve(attempt);
    });
    const repair = await launcher.startMinecraftPreparation(game.id, 'repair');
    expect((await done.promise).id).toBe(repair.id);
    stop();
    await writeJson(path, { ...repair, state: 'running', phase: 'verify', cancellable: false });
    const reopened = restart();
    expect(await reopened.readMinecraftPreparationActivity()).toEqual([]);
    expect(await reopened.readMinecraftPreparation(game.id)).toMatchObject({
      id: repair.id,
      mode: 'repair',
      state: 'ready',
    });
  } finally {
    prepare.mockRestore();
  }
});

test('waits for the active Minecraft process and cancels only the requested preparation', async () => {
  const launcher = createLauncher({
    dataDir: await fixture(),
    catalogUrl: 'https://catalog.test',
    webUrl: 'https://web.test',
    launcherVersion: '1.0.0',
    openExternal: async () => {},
  });
  const playing = await launcher.createMinecraft({ name: 'Playing', loader: 'vanilla' });
  const discarded = await launcher.createMinecraft({ name: 'Cancelled from queue', loader: 'vanilla' });
  const repairing = await launcher.createMinecraft({ name: 'Repair after play', loader: 'vanilla' });
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue({ versionId: 'fixture', javaMajor: 21 });
  let child: ChildProcess | undefined;
  const start = spyOn(Minecraft.prototype, 'start').mockImplementation(async (_game, _install, _settings, observe) => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    observe?.(child, 'fixture-process-token', Promise.resolve());
    return { child, accessToken: 'fixture-process-token' };
  });
  const firstWait = Promise.withResolvers<void>();
  const secondWait = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<MinecraftPreparation>();
  const repaired = Promise.withResolvers<MinecraftPreparation>();
  const stop = launcher.subscribeMinecraftPreparation((attempt) => {
    if (attempt.instanceId === discarded.id) {
      if (attempt.state === 'running' && attempt.phase === 'waiting-for-game') firstWait.resolve();
      if (attempt.state === 'cancelled') cancelled.resolve(attempt);
    }
    if (attempt.instanceId === repairing.id) {
      if (attempt.state === 'running' && attempt.phase === 'waiting-for-game') secondWait.resolve();
      if (attempt.state === 'ready') repaired.resolve(attempt);
    }
  });
  const expired = Symbol('deadline');
  const timeout = setTimeout(3500, expired, { ref: false });
  async function next<T>(event: Promise<T>) {
    const result = await Promise.race([event, timeout]);
    if (result === expired) throw new Error('The next Minecraft preparation state did not arrive.');
    return result;
  }
  try {
    await launcher.prepareMinecraft(playing.id);
    const session = await launcher.launch(playing.id);
    await expect(launcher.startMinecraftPreparation(playing.id, 'repair')).rejects.toThrow('Close the game');
    const first = await launcher.startMinecraftPreparation(discarded.id, 'install');
    await next(firstWait.promise);
    const second = await launcher.startMinecraftPreparation(repairing.id, 'repair');
    expect((await launcher.readMinecraftPreparation(repairing.id))?.phase).toBe('queued');
    await launcher.cancelMinecraftPreparation(discarded.id, first.id);
    expect((await next(cancelled.promise)).id).toBe(first.id);
    await next(secondWait.promise);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await launcher.currentSession())?.pid).toBe(session.pid);
    await launcher.stopGame(session.sessionId);
    expect(await next(repaired.promise)).toMatchObject({
      id: second.id,
      mode: 'repair',
      state: 'ready',
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(await launcher.readMinecraftPreparation(discarded.id)).toMatchObject({ id: first.id, state: 'cancelled' });
  } finally {
    await Promise.allSettled([discarded, repairing].map(({ id }) => launcher.cancelMinecraftPreparation(id)));
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await launcher.waitForGameWork();
    stop();
    start.mockRestore();
    prepare.mockRestore();
  }
});

test('installs, verifies, cancels and repairs Minecraft with the desktop Node transport', async () => {
  const directory = await fixture();
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, 'fixtures', 'minecraft-preparation.ts')],
    target: 'node',
    format: 'esm',
  });
  const [entry] = bundle.outputs;
  if (!entry) throw new Error('Could not bundle the desktop preparation fixture.');
  // The desktop uses npm Undici in Node. Bun's built-in undici stub lacks this dispatcher API.
  const child = Bun.spawn(['node', '--input-type=module', '-', directory], {
    stdin: new Blob([await entry.text()]),
    stdout: 'inherit',
    stderr: 'inherit',
    signal: AbortSignal.timeout(12_000),
  });
  expect(await child.exited).toBe(0);
}, 16_000);
