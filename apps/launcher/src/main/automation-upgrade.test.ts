import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Minecraft } from '../../../../packages/launcher-core/src/minecraft';
import { levelSavedIn } from '../../../../packages/launcher-core/test/fixtures/minecraft-level';
import { createLauncherHost } from './host';

test('starts only a reviewed version change through the host CLI and preserves the source worlds', async () => {
  const scratch = resolve(import.meta.dir, '../../.temp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'automation-upgrade-'));
  const dataDir = join(root, 'profile');
  const request = join(root, 'command.json');
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const from = { loader: 'vanilla', version: '1.21.1' };
  const selection = { loader: 'vanilla', version: '1.20.1' };
  const java = { kind: 'custom', executable: join(root, 'java') } as const;
  const storedWorld = levelSavedIn(from.version);
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue({
    versionId: 'verified-fixture',
    javaRuntime: 'test-java',
    javaMajor: 17,
  });
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function cli(command: string, argument?: object | string, failure?: RegExp) {
    const input = typeof argument === 'string' || argument === undefined ? argument : request;
    if (input === request) await writeFile(request, JSON.stringify(argument));
    const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, ...(input ? [input] : [])], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(10_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(failure ? 1 : 0);
    if (failure) {
      expect(stderr).toMatch(failure);
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
      automation: {},
      fetch: (async (input) => {
        if (new URL(String(input)).pathname !== '/mc/game/version_manifest_v2.json') {
          throw new Error('Unexpected network request.');
        }
        return Response.json({
          versions: [from.version, selection.version].map((id) => ({
            id,
            type: 'release',
            url: `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`,
          })),
        });
      }) as typeof fetch,
    });
    const { id: instanceId } = await cli('create-minecraft', { name: 'Original', ...from });
    const saves = join(dataDir, 'instances', instanceId, 'game', 'saves');
    const selected = join(saves, 'Keep this world', 'level.dat');
    const sibling = join(saves, 'Other world', 'level.dat');
    for (const path of [selected, sibling]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, storedWorld);
    }

    const inPlace = await cli('preview-minecraft-version-change', { instanceId, selection, mode: 'in-place' });
    expect(inPlace).toMatchObject({ from, selection, inPlaceBlocker: 'worlds', java: { kind: 'managed' } });
    await cli('start-minecraft-version-change', inPlace, /Prepare a downgraded copy/);
    expect(await cli('minecraft-preparation', instanceId)).toBeNull();
    expect(await cli('minecraft-preparations')).toEqual([]);

    const copy = { instanceId, selection, mode: 'copy', java };
    expect(await cli('preview-minecraft-version-change', copy)).toMatchObject({
      worldIds: ['Keep this world', 'Other world'],
    });
    expect(await cli('preview-minecraft-version-change', { ...copy, worldIds: [] })).toMatchObject({
      worldIds: [],
      worldVersionRisk: null,
    });
    await cli('preview-minecraft-version-change', { ...copy, worldIds: null }, /Choose up to/);
    const worldIds = ['Keep this world'];
    const review = await cli('preview-minecraft-version-change', { ...copy, worldIds });
    expect(review).toMatchObject({
      from,
      selection,
      java,
      worldIds,
      worldVersionRisk: { worldVersion: from.version, targetVersion: selection.version },
    });
    await cli('start-minecraft-version-change', { ...review, worldIds: [] }, /Preview it again/);
    await cli('start-minecraft-version-change', { ...review, java: { kind: 'managed' } }, /Preview it again/);
    await cli('start-minecraft-version-change', review, /Review the world copy and confirm it/);
    const confirmed = { ...review, worldVersionConfirmation: review.worldVersionRisk };
    await writeFile(selected, levelSavedIn(selection.version));
    await cli('start-minecraft-version-change', confirmed, /Preview it again/);
    await writeFile(selected, storedWorld);
    expect(prepare).not.toHaveBeenCalled();

    const started = await cli('start-minecraft-version-change', confirmed);
    expect(started).toMatchObject({ instanceId, mode: 'upgrade', upgradeMode: 'copy', java, worldIds });
    await host.core.waitForPreparationWork();
    const finished = await cli('minecraft-preparation', instanceId);
    expect(finished).toMatchObject({ id: started.id, state: 'ready' });
    expect(finished.resultInstanceId).not.toBe(instanceId);
    expect(await cli('list-installed')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: instanceId, minecraft: expect.objectContaining(from) }),
        expect.objectContaining({
          id: finished.resultInstanceId,
          minecraft: expect.objectContaining({ ...selection, settings: { java } }),
        }),
      ]),
    );
    expect(prepare.mock.calls[0]?.[0].settings?.java).toEqual(java);
    const destination = join(dataDir, 'instances', finished.resultInstanceId, 'game', 'saves');
    expect(await readdir(destination)).toEqual(worldIds);
    expect(await readFile(join(destination, worldIds[0]!, 'level.dat'))).toEqual(storedWorld);
    expect(await readFile(selected)).toEqual(storedWorld);
    expect(await readFile(sibling)).toEqual(storedWorld);
  } finally {
    await host?.close();
    prepare.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
