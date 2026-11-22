import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fabricModJar } from '../../../../packages/launcher-core/test/fixtures/mod-jar';
import { createLauncherHost } from './host';

test('reviews, applies, and repairs managed mods through the running host CLI', async () => {
  const temp = resolve(import.meta.dir, '../../.temp');
  await mkdir(temp, { recursive: true });
  const dataDir = await mkdtemp(join(temp, 'automation-mods-'));
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const changed: string[] = [];
  const downloaded: string[] = [];
  const rootJar = fabricModJar('fixture-feature', '1.0.0');
  const requiredJar = fabricModJar('fixture-support', '1.0.0');
  let publishedRoot = rootJar;
  let rateLimitSearch = false;
  let searchCount = 0;
  let downloadsUnavailable = false;
  let pauseReplacement = false;
  const downloading = Promise.withResolvers<void>();
  const release = (id: string, project: string, bytes: Buffer, dependencies: unknown[] = [], loaders = ['fabric']) => ({
    id,
    project_id: project,
    name: project,
    version_number: '1.0.0',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders,
    dependencies,
    files: [
      {
        primary: true,
        filename: project + '.jar',
        url: 'https://cdn.modrinth.com/' + id,
        size: bytes.length,
        hashes: { sha512: createHash('sha512').update(bytes).digest('hex') },
      },
    ],
  });
  const feature = () =>
    release('root-release', 'feature', publishedRoot, [
      { project_id: 'support', version_id: 'required-release', dependency_type: 'required' },
    ]);
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    const name = url.pathname.split('/').at(-1)!;
    if (url.hostname === 'cdn.modrinth.com') {
      if (downloadsUnavailable) return new Response('Temporary private response body', { status: 503 });
      if (pauseReplacement && name === 'root-release') {
        const signal = init?.signal;
        if (!signal) throw new Error('The download has no cancellation signal.');
        signal.throwIfAborted();
        downloading.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      downloaded.push(name);
      return new Response(new Uint8Array(name === 'root-release' ? publishedRoot : requiredJar));
    }
    if (name === 'search') {
      searchCount++;
      if (rateLimitSearch) return new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '30' } });
      const facets = JSON.parse(url.searchParams.get('facets')!);
      expect(facets).toContainEqual(['categories:fabric']);
      expect(facets).toContainEqual(['versions:1.21.1']);
      return Response.json({ hits: [{ project_id: 'feature', title: 'Feature', description: 'Fixture feature' }] });
    }
    if (name === 'version') {
      expect(url.searchParams.get('loaders')).toEqual('["fabric"]');
      return Response.json([feature(), release('forge-release', 'feature', rootJar, [], ['forge'])]);
    }
    if (name === 'root-release') return Response.json(feature());
    if (name === 'required-release') return Response.json(release(name, 'support', requiredJar));
    throw new Error('Unexpected fixture request.');
  }) as typeof fetch;
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function startCli(command: string, payload: string | object) {
    const path = join(dataDir, 'request file.json');
    if (typeof payload !== 'string') await writeFile(path, JSON.stringify(payload));
    return Bun.spawn(
      [process.execPath, script, '--data-dir', dataDir, command, typeof payload === 'string' ? payload : path],
      { stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(8_000) },
    );
  }

  async function cli(command: string, payload: string | object, failure?: RegExp) {
    const child = await startCli(command, payload);
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
      webUrl: 'https://rezics.example.test',
      launcherVersion: '0.1.0',
      fetch: fetcher,
      openExternal: async () => {},
      automation: { onModFolderChanged: (id) => changed.push(id) },
    });
    const { id: instanceId } = await host.core.createMinecraft({ name: 'Mod CLI fixture', loader: 'fabric' });
    expect(await cli('search-minecraft-mods', { instanceId, query: 'feature' })).toMatchObject([{ id: 'feature' }]);
    expect(await cli('minecraft-mod-versions', { instanceId, projectId: 'feature' })).toMatchObject([
      { id: 'root-release' },
    ]);
    const install = { instanceId, versionId: 'root-release' };
    const plan = await cli('preview-minecraft-mod-install', install);
    expect(plan.changes).toMatchObject([
      { id: 'required-release', action: 'install' },
      { id: 'root-release', action: 'install' },
    ]);
    await cli('install-minecraft-mod', install, /Review this mod installation/);
    publishedRoot = fabricModJar('fixture-feature', '1.0.1');
    await cli('install-minecraft-mod', { ...install, revision: plan.revision }, /Refresh the preview/);
    expect(downloaded).toEqual([]);
    expect(changed).toEqual([]);
    publishedRoot = rootJar;
    await cli('install-minecraft-mod', { ...install, revision: plan.revision });
    expect(downloaded).toEqual(['required-release', 'root-release']);
    if (process.platform !== 'win32') {
      const home = join(dataDir, 'instances', instanceId, 'installed-mods');
      const ledger = join(home, 'installed.json');
      const staging = join(home, 'install-staging');
      const before = await readFile(ledger);
      const reviewed = await cli('preview-minecraft-mod-install', install);
      pauseReplacement = true;
      const child = await startCli('install-minecraft-mod', { ...install, revision: reviewed.revision });
      try {
        await Promise.race([
          downloading.promise,
          child.exited.then(() => {
            throw new Error('The CLI exited before starting the staged download.');
          }),
        ]);
        expect(await readFile(join(staging, 'artifact-0'))).toEqual(requiredJar);
        child.kill('SIGINT');
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stderr).text()).toContain('The Launcher command was interrupted.');
        expect(await cli('minecraft-mods', instanceId)).toMatchObject([
          { id: 'modrinth:support' },
          { id: 'modrinth:feature' },
        ]);
        expect(await readFile(ledger)).toEqual(before);
        await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(changed).toEqual([instanceId]);
      } finally {
        pauseReplacement = false;
        if (child.exitCode === null) child.kill('SIGINT');
        await child.exited;
      }
    }
    const support = 'modrinth:support';
    const featureId = 'modrinth:feature';
    const disable = { instanceId, packageId: support, enabled: false };
    const preview = await cli('preview-minecraft-mod-state', disable);
    expect(preview.changes).toMatchObject([{ id: support }, { id: featureId }]);
    await cli('apply-minecraft-mod-state', { ...disable, revision: preview.revision });
    expect(await cli('minecraft-mods', instanceId)).toMatchObject([
      { id: support, releaseId: 'required-release', enabled: false },
      { id: featureId, releaseId: 'root-release', enabled: false },
    ]);
    const mods = join(dataDir, 'instances', instanceId, 'game', 'mods');
    const disabledSupport = join(mods, `rezics-${createHash('sha256').update(support).digest('hex')}.jar.disabled`);
    await writeFile(disabledSupport, Buffer.alloc(requiredJar.length));
    downloadsUnavailable = true;
    await cli('repair-minecraft-mod', { instanceId, packageId: support }, /Modrinth download service.*HTTP 503/);
    expect(await readFile(disabledSupport)).toEqual(Buffer.alloc(requiredJar.length));
    downloadsUnavailable = false;
    await cli('repair-minecraft-mod', { instanceId, packageId: support });
    expect(await readFile(disabledSupport)).toEqual(requiredJar);

    const local = join(dataDir, 'Import fixture.jar');
    await writeFile(local, fabricModJar('fixture-local', '1.0.0'));
    await cli('import-minecraft-mod', { instanceId, file: local });
    const enable = { instanceId, packageId: featureId, enabled: true };
    const reviewed = await cli('preview-minecraft-mod-state', enable);
    await cli('apply-minecraft-mod-state', { ...enable, revision: reviewed.revision });
    await cli('remove-minecraft-mod', { instanceId, packageId: support }, /requires modrinth:support/);
    await cli('remove-minecraft-mod', { instanceId, packageId: featureId });
    await cli('remove-minecraft-mod', { instanceId, packageId: support });
    expect(await cli('minecraft-mods', instanceId)).toMatchObject([{ id: 'local:fixture-local', enabled: true }]);
    const beforeLimit = searchCount;
    rateLimitSearch = true;
    await cli('search-minecraft-mods', { instanceId, query: 'feature' }, /Modrinth is rate limiting.*30s/);
    await cli('search-minecraft-packs', { query: 'fixture' }, /Modrinth is rate limiting/);
    expect(searchCount).toBe(beforeLimit + 1);
    expect(await cli('minecraft-mods', instanceId)).toMatchObject([{ id: 'local:fixture-local', enabled: true }]);
    expect(changed).toEqual(Array(7).fill(instanceId));
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
