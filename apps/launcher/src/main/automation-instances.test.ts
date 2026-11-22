import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createLauncherHost } from './host';

test('manages instances through the profile owner and requires the current archive for permanent deletion', async () => {
  const temporary = resolve(import.meta.dir, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const dataDir = await mkdtemp(join(temporary, 'automation-instances-'));
  const request = join(dataDir, 'Instance command.json');
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const changes: (readonly string[] | undefined)[] = [];
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function cli(command: string, input?: object | string, failure?: RegExp) {
    const path = typeof input === 'object' ? request : input;
    if (typeof input === 'object') await writeFile(request, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, ...(path ? [path] : [])], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(10_000),
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, error).toBe(failure ? 1 : 0);
    if (failure) {
      expect(error).toMatch(failure);
      expect(output).toBe('');
      return;
    }
    return JSON.parse(output);
  }

  const worldPath = (id: string) => join(dataDir, 'instances', id, 'game/saves/Fixture world/level.dat');
  const configPath = (id: string) => join(dataDir, 'instances', id, 'game/config/settings.txt');

  try {
    host = await createLauncherHost({
      dataDir,
      catalogUrl: 'https://catalog.example.test',
      webUrl: 'https://rezics.example.test',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
      automation: { onInstalledChanged: (archive) => changes.push(archive) },
    });
    const original = await host.core.createMinecraft({ name: 'Original', loader: 'vanilla' });
    const { id: instanceId } = original;
    const world = worldPath(instanceId);
    const settings = configPath(instanceId);
    for (const path of [world, settings]) await mkdir(dirname(path), { recursive: true });
    await writeFile(world, 'original world');
    await writeFile(settings, 'original settings');
    const snapshot = await host.core.createSnapshot(instanceId, 'Original world backup');

    const renamed = await cli('rename-minecraft', { instanceId, name: '  Renamed original  ' });
    expect(renamed).toEqual({ ...original, name: 'Renamed original' });
    await cli('duplicate-minecraft', { instanceId, name: 'No world choice' }, /Choose whether/);
    const clean = await cli('duplicate-minecraft', { instanceId, name: 'Without worlds', copyWorlds: false });
    const withWorld = await cli('duplicate-minecraft', { instanceId, name: 'With worlds', copyWorlds: true });
    expect(new Set([instanceId, clean.id, withWorld.id]).size).toBe(3);
    expect(await cli('list-worlds', clean.id)).toEqual([]);
    expect(await cli('list-worlds', withWorld.id)).toEqual([{ id: 'Fixture world', name: 'Fixture world' }]);
    expect(await cli('list-backups', withWorld.id)).toEqual([]);
    expect(await readFile(worldPath(withWorld.id), 'utf8')).toBe('original world');
    expect(await readFile(configPath(clean.id), 'utf8')).toBe('original settings');
    await writeFile(worldPath(withWorld.id), 'independent world');
    expect(await readFile(world, 'utf8')).toBe('original world');

    expect(await cli('archive-minecraft', instanceId)).toEqual({ status: 'archived', instanceId });
    expect(await cli('list-installed')).toEqual([withWorld, clean]);
    const [archived] = await cli('list-archived-minecraft');
    expect(archived).toMatchObject(renamed);
    expect(archived.revision).toMatch(/^[a-f0-9]{64}$/u);
    await cli('delete-archived-minecraft', { instanceId, revision: archived.revision }, /Confirm the exact/);
    const reviewedDeletion = { instanceId, confirmInstanceId: instanceId, revision: archived.revision };
    expect(await cli('restore-archived-minecraft', instanceId)).toEqual(renamed);
    expect(await cli('list-archived-minecraft')).toEqual([]);
    expect(await cli('list-backups', instanceId)).toEqual([snapshot]);
    expect(await readFile(world, 'utf8')).toBe('original world');
    await cli('delete-archived-minecraft', reviewedDeletion, /Choose an archived/);

    await cli('archive-minecraft', instanceId);
    const [current] = await cli('list-archived-minecraft');
    expect(current.id).toBe(instanceId);
    expect(current.revision).not.toBe(archived.revision);
    await cli('delete-archived-minecraft', reviewedDeletion, /archive entry changed/);
    expect(await cli('list-archived-minecraft')).toEqual([current]);
    expect(await cli('delete-archived-minecraft', { ...reviewedDeletion, revision: current.revision })).toEqual({
      status: 'deleted',
      instanceId,
    });
    expect(await cli('list-archived-minecraft')).toEqual([]);
    expect(await cli('list-installed')).toEqual([withWorld, clean]);
    expect(await readFile(worldPath(withWorld.id), 'utf8')).toBe('independent world');
    expect(changes).toEqual([undefined, undefined, undefined, [instanceId], undefined, [instanceId], undefined]);
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 25_000);
