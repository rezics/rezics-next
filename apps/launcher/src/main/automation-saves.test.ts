import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createLauncherHost } from './host';

test('the CLI shares the running host and restores only the reviewed world', async () => {
  const temporary = resolve(import.meta.dir, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const dataDir = await mkdtemp(join(temporary, 'automation-saves-'));
  const changed: string[] = [];
  const host = await createLauncherHost({
    dataDir,
    catalogUrl: 'https://catalog.example.test',
    webUrl: 'https://rezics.example.test',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
    automation: { onSaveHistoryChanged: (id) => changed.push(id) },
  }).catch(async (error: unknown) => {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const instance = await host.core.createMinecraft({ name: 'Automation world', loader: 'vanilla' });
    const root = join(dataDir, 'instances', instance.id, 'game', 'saves');
    const first = join(root, 'First world');
    const peer = join(root, 'Second world');
    await mkdir(first, { recursive: true });
    await mkdir(peer);
    await writeFile(join(first, 'level.dat'), 'backup');
    await writeFile(join(peer, 'level.dat'), 'peer');

    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    async function cli(command: string, payload: unknown, outcome?: RegExp | 2) {
      const file = join(dataDir, 'request.json');
      if (typeof payload !== 'string') await writeFile(file, JSON.stringify(payload));
      const child = Bun.spawn(
        [process.execPath, script, '--data-dir', dataDir, command, typeof payload === 'string' ? payload : file],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          signal: AbortSignal.timeout(8_000),
        },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, error).toBe(outcome instanceof RegExp ? 1 : (outcome ?? 0));
      if (outcome instanceof RegExp) {
        expect(error).toMatch(outcome);
        expect(output).toBe('');
        return;
      }
      return JSON.parse(output);
    }

    const worlds = await cli('list-worlds', instance.id);
    expect(worlds.map(({ id }: { id: string }) => id)).toEqual(['First world', 'Second world']);
    const instanceId = instance.id;
    const snapshot = await cli('create-backup', { instanceId, selection: { kind: 'world', id: 'First world' } });
    expect(await cli('list-backups', instanceId)).toEqual([snapshot]);
    const selection = { instanceId, snapshotId: snapshot.id };
    const home = join(dataDir, 'instances', instanceId);
    const stored = join(home, 'snapshots', snapshot.id, 'snapshot.json');
    const earlier = JSON.parse(await readFile(stored, 'utf8'));
    delete earlier.roots[0].sha256;
    await writeFile(stored, JSON.stringify(earlier));
    for (const id of ['snapshot-damaged', 'snapshot-mismatched', 'snapshot-missing']) {
      await mkdir(join(home, 'snapshots', id));
    }
    await writeFile(join(home, 'snapshots', 'snapshot-damaged', 'snapshot.json'), '{"id":');
    await writeFile(join(home, 'snapshots', 'snapshot-mismatched', 'snapshot.json'), JSON.stringify(earlier));
    const journal = join(home, 'restore-journal.json');
    await writeFile(journal, '{"phase":');
    expect(await cli('backup-history', instanceId, 2)).toEqual({
      snapshots: [snapshot],
      issues: [
        { id: 'snapshot-damaged', reason: 'invalid-metadata' },
        { id: 'snapshot-mismatched', reason: 'invalid-metadata' },
        { id: 'snapshot-missing', reason: 'unavailable' },
      ],
    });
    expect(await cli('list-backups', instanceId)).toEqual([snapshot]);
    expect(await readFile(journal, 'utf8')).toBe('{"phase":');
    await rm(journal);
    await cli('preview-restore', { instanceId, snapshotId: 'snapshot-damaged' }, /invalid metadata/);
    await cli('restore-backup', selection, /Preview this backup/);
    const original = await cli('preview-restore', selection);
    await rename(first, join(dataDir, 'moved'));
    await mkdir(first);
    await writeFile(join(first, 'level.dat'), 'replacement');
    await cli('restore-backup', { ...selection, review: original.review }, /Preview this backup again/);
    expect(await readFile(join(first, 'level.dat'), 'utf8')).toBe('replacement');
    const current = await cli('preview-restore', selection);
    expect(await cli('restore-backup', { ...selection, review: current.review })).toEqual({
      ...selection,
      status: 'restored',
    });
    expect(await readFile(join(first, 'level.dat'), 'utf8')).toBe('backup');
    expect(await readFile(join(peer, 'level.dat'), 'utf8')).toBe('peer');
    expect(changed).toEqual([instanceId, instanceId]);

    await cli('set-backup-pinned', { ...selection, pinned: 'true' }, /Choose whether to keep/);
    await cli('set-backup-pinned', { ...selection, pinned: true });
    await cli('delete-backup', selection, /Unpin this backup/);
    const folder = 'Portable backups';
    await mkdir(join(dataDir, folder));
    const exported = await cli('export-backup', { ...selection, folder });
    expect(relative(dataDir, exported.path).split(/[/\\]/u)[0]).toBe(folder);
    const manifest = await readFile(join(exported.path, 'backup.json'), 'utf8');
    expect(manifest).not.toContain(instanceId);
    const receiving = await host.core.createMinecraft({ name: 'Receiving instance', loader: 'vanilla' });
    const receivingWorld = join(dataDir, 'instances', receiving.id, 'game', 'saves', 'First world');
    await mkdir(receivingWorld, { recursive: true });
    await writeFile(join(receivingWorld, 'level.dat'), 'receiving world');
    const source = { instanceId: receiving.id, folder: relative(dataDir, exported.path) };
    const imported = await cli('import-backup', source);
    expect(imported).toMatchObject({ pinned: true, selection: snapshot.selection });
    expect(imported.id).not.toBe(snapshot.id);
    expect(await readFile(join(receivingWorld, 'level.dat'), 'utf8')).toBe('receiving world');
    const copied = { instanceId: receiving.id, snapshotId: imported.id };
    const importedPreview = await cli('preview-restore', copied);
    expect(importedPreview.targets).toMatchObject([{ path: receivingWorld }]);
    await cli('restore-backup', { ...copied, review: importedPreview.review });
    expect(await readFile(join(receivingWorld, 'level.dat'), 'utf8')).toBe('backup');
    await cli('delete-backup', copied, /Unpin this backup/);
    await cli('set-backup-pinned', { ...copied, pinned: false });
    expect(await cli('delete-backup', copied)).toEqual({ ...copied, status: 'deleted' });
    expect((await cli('list-backups', receiving.id)).map(({ id }: { id: string }) => id)).not.toContain(imported.id);
    const origin = await cli('list-backups', instance.id);
    expect(origin.find(({ id }: { id: string }) => id === snapshot.id)).toMatchObject({ pinned: true });
    expect(changed).toEqual([
      instanceId,
      instanceId,
      instanceId,
      receiving.id,
      receiving.id,
      receiving.id,
      receiving.id,
    ]);
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
