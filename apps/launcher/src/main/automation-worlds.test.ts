import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { levelSavedIn } from '../../../../packages/launcher-core/test/fixtures/minecraft-level';
import { createLauncherHost } from './host';

test('reviews and transfers a world with the GUI closed and refreshes the owning host after publication', async () => {
  const scratch = resolve(import.meta.dir, '../../.temp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'automation-worlds-'));
  const dataDir = join(root, 'profile');
  const path = join(root, 'World command.json');
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const changed: string[] = [];
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function cli(command: string, input: object | string, failure?: RegExp) {
    if (typeof input !== 'string') await writeFile(path, JSON.stringify(input));
    const child = Bun.spawn(
      [process.execPath, script, '--data-dir', dataDir, command, typeof input === 'string' ? input : path],
      { stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(8_000) },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(failure ? 1 : 0);
    if (failure) {
      expect(stderr).toMatch(failure);
      expect(stdout).toBe('');
      return;
    }
    return JSON.parse(stdout);
  }

  try {
    host = await createLauncherHost({
      dataDir,
      catalogUrl: 'https://catalog.example.test',
      webUrl: 'https://web.example.test',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
      automation: { onSaveHistoryChanged: (id) => changed.push(id) },
    });
    const left = await host.core.createMinecraft({ name: 'First instance', loader: 'vanilla' });
    const right = await host.core.createMinecraft({ name: 'Second instance', loader: 'vanilla' });
    const leftSaves = join(dataDir, 'instances', left.id, 'game', 'saves');
    const peer = join(leftSaves, 'Existing world');
    await mkdir(peer, { recursive: true });
    await writeFile(join(peer, 'level.dat'), 'keep existing world bytes');

    const source = join(root, 'External world');
    const level = levelSavedIn('1.21.2');
    const region = join(source, 'region', 'r.0.0.mca');
    await mkdir(join(source, 'region'), { recursive: true });
    await writeFile(join(source, 'level.dat'), level);
    await writeFile(join(source, 'session.lock'), 'external lock');
    await writeFile(region, 'first region');
    const request = { instanceId: left.id, source: { kind: 'folder', path: source } };
    await cli('import-minecraft-world', request, /Preview the Minecraft world import/);
    const preview = await cli('preview-minecraft-world', request);
    expect(preview).toMatchObject({
      name: 'External world',
      targetVersion: '1.21.1',
      world: { files: 2, minecraftVersion: '1.21.2' },
      versionRisk: { worldVersion: '1.21.2', targetVersion: '1.21.1' },
    });
    await cli('import-minecraft-world', preview, /confirm the import/);
    await cli('import-minecraft-world', { ...preview, name: 'Different destination' }, /choices changed/);
    await cli('import-minecraft-world', { ...preview, instanceId: right.id }, /choices changed/);
    await writeFile(region, 'later region');
    await cli(
      'import-minecraft-world',
      { ...preview, worldVersionConfirmation: preview.versionRisk },
      /world folder changed/,
    );
    expect(changed).toEqual([]);
    expect(await cli('list-worlds', left.id)).toEqual([{ id: 'Existing world', name: 'Existing world' }]);

    const current = await cli('preview-minecraft-world', { ...request, name: ' First copy ' });
    expect(current.name).toBe('First copy');
    const copy = { id: 'First copy', name: 'First copy' };
    const approved = { ...current, worldVersionConfirmation: current.versionRisk };
    expect(await cli('import-minecraft-world', approved)).toEqual(copy);
    await cli('import-minecraft-world', approved, /already has a folder or file/);
    const firstCopy = join(leftSaves, copy.id);
    expect(await readFile(join(firstCopy, 'region', 'r.0.0.mca'), 'utf8')).toBe('later region');
    expect(await Bun.file(join(firstCopy, 'session.lock')).exists()).toBe(false);
    expect(await readFile(join(peer, 'level.dat'), 'utf8')).toBe('keep existing world bytes');

    const zip = join(root, 'Portable world.zip');
    const exportRequest = { instanceId: left.id, worldId: copy.id, path: zip };
    expect(await cli('export-minecraft-world', exportRequest)).toEqual({ path: zip });
    await cli('export-minecraft-world', exportRequest, /already a file/);
    const receive = { instanceId: right.id, source: { kind: 'zip', path: zip }, name: 'Second copy' };
    const stale = await cli('preview-minecraft-world', receive);
    expect(stale).toMatchObject({ targetVersion: '1.21.1', versionRisk: preview.versionRisk });
    const instanceFile = join(dataDir, 'instances', right.id, 'instance.json');
    const record = JSON.parse(await readFile(instanceFile, 'utf8'));
    record.minecraft.version = '1.21.2';
    await writeFile(instanceFile, JSON.stringify(record));
    await cli(
      'import-minecraft-world',
      { ...stale, worldVersionConfirmation: stale.versionRisk },
      /destination Minecraft release changed/,
    );
    expect(await cli('list-worlds', right.id)).toEqual([]);

    const ready = await cli('preview-minecraft-world', receive);
    expect(ready).toMatchObject({ targetVersion: '1.21.2', world: { minecraftVersion: '1.21.2' } });
    expect(ready.versionRisk).toBeUndefined();
    expect(await cli('import-minecraft-world', ready)).toEqual({ id: receive.name, name: receive.name });
    const secondCopy = join(dataDir, 'instances', right.id, 'game', 'saves', receive.name);
    expect(await readFile(join(secondCopy, 'level.dat'))).toEqual(level);
    expect(await readFile(join(secondCopy, 'region', 'r.0.0.mca'), 'utf8')).toBe('later region');
    await writeFile(join(secondCopy, 'region', 'r.0.0.mca'), 'changed independently');
    expect(await readFile(join(firstCopy, 'region', 'r.0.0.mca'), 'utf8')).toBe('later region');
    expect(await readFile(region, 'utf8')).toBe('later region');
    expect(changed).toEqual([left.id, right.id]);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
