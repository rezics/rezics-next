import type { Instance, VisualNovelSettings, VisualNovelSettingsPatch } from '@rezics/launcher-contract';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLauncherHost } from './host';

test('an agent can revise 100 imported visual novels and repair a moved game with its backups', async () => {
  const temporary = resolve(import.meta.dir, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'automation-vn-settings-'));
  const dataDir = join(root, 'profile');
  const request = join(root, 'Visual novel request.json');
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const changes: string[] = [];
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function cli(command: string, input?: object | string, partial = false, pipe = false) {
    const argument = pipe ? '-' : typeof input === 'string' ? input : request;
    if (!pipe && typeof input === 'object') await writeFile(request, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, ...(input ? [argument] : [])], {
      cwd: root,
      stdin: pipe ? Buffer.from('\ufeff' + JSON.stringify(input)) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(10_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(partial ? 2 : 0);
    return JSON.parse(stdout);
  }

  try {
    host = await createLauncherHost({
      dataDir,
      catalogUrl: 'https://catalog.example.test',
      webUrl: 'https://rezics.example.test',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
      automation: { onInstalledChanged: () => changes.push('installed') },
    });
    const imports = [];
    for (let index = 0; index < 100; index++) {
      const folder = `Games/Game ${index}`;
      await mkdir(join(root, folder, 'game'), { recursive: true });
      await writeFile(join(root, folder, 'game/options.rpy'), `define config.name = "Original ${index}"\n`);
      await writeFile(join(root, folder, 'story.exe'), 'fixture');
      imports.push({ executable: join(folder, 'story.exe') });
    }
    const old = join(root, 'Games/Game 0');
    await mkdir(join(old, 'saves'));
    await writeFile(join(old, 'saves', 'slot.save'), 'original progress');
    const first = { ...imports[0]!, saveDirectory: 'Games/Game 0/saves' };
    const inspected = await cli('inspect-vn', imports, false, true);
    expect(inspected).toHaveLength(100);
    expect(inspected[0]).toMatchObject({ metadata: { engine: 'renpy', title: 'Original 0' } });
    expect(inspected.at(-1)).toMatchObject({ metadata: { engine: 'renpy', title: 'Original 99' } });
    const imported: { status: string; instance: Instance }[] = await cli('import-vn', [first, ...imports.slice(1)]);
    expect(imported.filter(({ status }) => status === 'imported')).toHaveLength(100);
    const instances = imported.map(({ instance }) => ({ instanceId: instance.id }));
    const backups = await cli('read-automatic-backups', [...instances, { instanceId: 'missing' }], true);
    expect(backups.slice(0, 100)).toEqual(
      instances.map((instance, index) => ({ index, ...instance, status: 'ready', backup: { state: 'idle' } })),
    );
    expect(backups.at(-1)).toMatchObject({ index: 100, instanceId: 'missing', status: 'error' });
    const original = instances[0]!;
    const subjectId = '018943aa-abcd-4abc-9abc-0123456789ab';
    expect(await cli('link-vn', [{ ...original, expectedSubjectId: null, subjectId }], false, true)).toMatchObject([
      { status: 'changed' },
    ]);
    const snapshot = await cli('create-backup', { ...original, label: 'Before the move' });
    const read: { status: string; settings: VisualNovelSettings }[] = await cli(
      'read-vn-settings',
      [...instances, { instanceId: 'missing' }],
      true,
    );
    expect(read.filter(({ status }) => status === 'ready')).toHaveLength(100);
    expect(read.at(-1)).toMatchObject({ status: 'error', instanceId: 'missing' });
    expect(read[0]?.settings).toMatchObject({ metadata: { engine: 'renpy', title: 'Original 0' }, subjectId });
    const moved = join(root, 'Moved release');
    await rename(old, moved);
    await host.core.updateVisualNovelSettings(instances[1]!.instanceId, { name: 'Changed on desktop' });
    const edits: { instanceId: string; revision: string; patch: VisualNovelSettingsPatch }[] = instances.map(
      ({ instanceId }, index) => ({
        instanceId,
        revision: read[index]!.settings.revision,
        patch: { name: `Organized ${index}` },
      }),
    );
    edits[0] = {
      ...edits[0]!,
      patch: {
        ...edits[0]!.patch,
        executable: 'Moved release/story.exe',
        workingDirectory: null,
        saveDirectory: 'Moved release/saves',
      },
    };
    const invalid = { ...edits[2]!, patch: { subjectId: null } };
    const changed = await cli('edit-vn', [edits[0], edits[1], invalid, ...edits.slice(3)], true);
    expect(changed.filter(({ status }: { status: string }) => status === 'changed')).toHaveLength(98);
    expect(changed[1]).toMatchObject({ status: 'conflict', instance: { name: 'Changed on desktop' } });
    expect(changed[2]).toMatchObject({ status: 'error', message: 'Use link-vn to change REZICS associations.' });
    expect(changed[0]).toMatchObject({ status: 'changed', instance: { id: original.instanceId, subjectId } });

    const retries = [{ ...edits[1]!, revision: changed[1].revision }, edits[2]!];
    expect(await cli('edit-vn', retries)).toMatchObject([{ status: 'changed' }, { status: 'changed' }]);
    expect(await cli('edit-vn', [edits[0], ...retries])).toMatchObject([
      { status: 'unchanged' },
      { status: 'unchanged' },
      { status: 'unchanged' },
    ]);
    expect(changes).toEqual(['installed', 'installed', 'installed', 'installed']);
    const updated = await cli('read-vn-settings', [original]);
    expect(updated).toMatchObject([
      {
        status: 'ready',
        settings: {
          name: 'Organized 0',
          executable: join(moved, 'story.exe'),
          saveDirectory: join(moved, 'saves'),
          subjectId,
        },
      },
    ]);
    expect(await cli('list-backups', original.instanceId)).toEqual([snapshot]);
    const slot = join(moved, 'saves', 'slot.save');
    await writeFile(slot, 'new local progress');
    const restore = { ...original, snapshotId: snapshot.id };
    const preview = await cli('preview-restore', restore);
    expect(preview.targets).toMatchObject([{ path: join(moved, 'saves') }]);
    await cli('restore-backup', { ...restore, review: preview.review });
    expect(await readFile(slot, 'utf8')).toBe('original progress');
    const backupHistory = await cli('list-backups', original.instanceId);

    const requestRows = [...instances, { instanceId: 'missing' }];
    const archived = await cli('archive-local-games', requestRows, true);
    expect(archived.filter(({ status }: { status: string }) => status === 'archived')).toHaveLength(100);
    expect(archived.at(-1)).toMatchObject({ status: 'error', instanceId: 'missing' });
    expect(await cli('archive-local-games', [original])).toMatchObject([{ status: 'unchanged' }]);
    expect(await cli('list-installed')).toEqual([]);
    expect(await cli('list-archived-local-games')).toHaveLength(100);
    expect(await cli('list-archived-minecraft')).toEqual([]);

    const archivedInput = { executable: 'Moved release/story.exe' };
    const scan = await cli('discover-vn', moved);
    expect(scan.installations[0]?.candidates[0]).toMatchObject({
      archived: true,
      instance: { id: original.instanceId, subjectId },
    });
    expect(await cli('import-vn', [archivedInput])).toMatchObject([
      { status: 'archived', instance: { id: original.instanceId, subjectId } },
    ]);
    await expect(
      host.core.importInstance({
        kind: 'visual-novel',
        name: 'Manual import',
        executable: join(moved, 'story.exe'),
      }),
    ).rejects.toThrow('This installation is archived.');
    expect(await readFile(slot, 'utf8')).toBe('original progress');
    expect(await readFile(join(moved, 'story.exe'), 'utf8')).toBe('fixture');
    const restored = await cli('restore-archived-local-games', requestRows, true);
    expect(restored.filter(({ status }: { status: string }) => status === 'restored')).toHaveLength(100);
    expect(await cli('restore-archived-local-games', [original])).toMatchObject([{ status: 'unchanged' }]);
    expect(await cli('list-archived-local-games')).toEqual([]);
    expect(await cli('list-installed')).toHaveLength(100);
    expect(await cli('list-backups', original.instanceId)).toEqual(backupHistory);
    expect(await cli('import-vn', [archivedInput])).toMatchObject([
      { status: 'existing', instance: { id: original.instanceId, subjectId } },
    ]);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
