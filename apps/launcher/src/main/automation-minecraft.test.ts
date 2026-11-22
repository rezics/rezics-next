import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Minecraft } from '../../../../packages/launcher-core/src/minecraft';
import { createLauncherHost } from './host';

test.skipIf(process.platform === 'win32')(
  'prepares, authorizes and starts a Minecraft fixture through a windowless host',
  async () => {
    const temp = resolve(import.meta.dir, '../../.temp');
    await mkdir(temp, { recursive: true });
    const directory = await mkdtemp(join(temp, 'automation-minecraft-'));
    const dataDir = join(directory, 'profile');
    const request = join(directory, 'request.json');
    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    const java = join(directory, 'java');
    const wrongJava = join(directory, 'wrong', 'java');
    const version = '1.21.1';
    const created: string[] = [];
    const privateDevice = 'device-private-fixture';
    const privateAccess = 'minecraft-private-fixture';
    let approved = false;
    let metadataAvailable = true;
    let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;
    const probe = process.arch === 'arm64' ? 'aarch64' : 'amd64';
    const jar = 'checked Minecraft client fixture';
    const profile = {
      id: version,
      type: 'release',
      mainClass: 'fixture.Game',
      minimumLauncherVersion: 21,
      time: '2024-08-08T00:00:00Z',
      releaseTime: '2024-08-08T00:00:00Z',
      arguments: { jvm: [], game: ['--accessToken', '${auth_access_token}'] },
      assets: 'fixture-assets',
      libraries: [],
      downloads: { client: { sha1: createHash('sha1').update(jar).digest('hex'), size: jar.length } },
      javaVersion: { component: 'fixture-java', majorVersion: 21 },
    };
    const fetcher = (async (input, init) => {
      const url = new URL(String(input));
      switch (url.pathname.split('/').at(-1)) {
        case 'version_manifest_v2.json':
          return Response.json({
            latest: { release: version },
            versions: [
              {
                id: version,
                type: 'release',
                url: `https://piston-meta.mojang.com/v1/packages/fixture/${version}.json`,
              },
            ],
          });
        case version:
          return Response.json([{ loader: { version: '0.16.14', stable: true } }]);
        case `${version}.json`:
          if (!metadataAvailable) return new Response(null, { status: 503 });
          return Response.json(profile);
        case 'devicecode':
          expect((init?.body as URLSearchParams).get('client_id')).toBe('approved-app-fixture');
          return Response.json({
            device_code: privateDevice,
            user_code: 'FIXTURE-PUBLIC',
            verification_uri: 'https://www.microsoft.com/link',
            expires_in: 60,
            interval: 1,
          });
        case 'token':
          return approved
            ? Response.json({ access_token: 'microsoft-access-fixture', refresh_token: 'microsoft-refresh-fixture' })
            : Response.json({ error: 'authorization_pending' }, { status: 400 });
        case 'authenticate':
          return Response.json({ Token: 'xbox-access-fixture' });
        case 'authorize':
          return Response.json({ Token: 'xsts-access-fixture', DisplayClaims: { xui: [{ uhs: 'fixture' }] } });
        case 'login_with_xbox':
          return Response.json({ access_token: privateAccess, expires_in: 3600 });
        case 'mcstore':
          return Response.json({ items: [{ name: 'game_minecraft' }] });
        case 'profile':
          return Response.json({ id: 'fixture-profile', name: 'FixturePlayer' });
      }
      throw new Error('Unexpected fixture provider request.');
    }) as typeof fetch;
    const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async (_selection, job) => {
      await job.report('assets', { completed: 1, total: 2 });
      if (job.mode === 'install') await setTimeout(30_000, undefined, { signal: job.signal });
      const profiles = join(dataDir, 'minecraft-resources', 'versions', version);
      await mkdir(profiles, { recursive: true });
      await writeFile(join(profiles, `${version}.jar`), jar);
      await writeFile(join(profiles, `${version}.json`), JSON.stringify(profile));
      return { versionId: version, javaMajor: 21 };
    });

    async function cli(command: string, argument?: unknown, failure?: RegExp, partial = false) {
      const input = typeof argument === 'string' ? argument : argument === undefined ? undefined : request;
      if (input === request) await writeFile(request, JSON.stringify(argument));
      const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, ...(input ? [input] : [])], {
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(8_000),
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(failure ? 1 : partial ? 2 : 0);
      if (failure) {
        expect(stderr).toMatch(failure);
        return;
      }
      expect(stdout).not.toContain(privateDevice);
      expect(stdout).not.toContain(privateAccess);
      return JSON.parse(stdout);
    }

    async function observe(read: () => Promise<unknown>, key: string, value: string) {
      let result: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await read();
        if (result && result[key as keyof typeof result] === value) return result;
        await setTimeout(40);
      }
      throw new Error(`Fixture did not reach ${key} ${value}. Last result: ${JSON.stringify(result)}`);
    }

    try {
      await cli('start-minecraft-sign-in', {}, /start the terminal host with serve/);
      await writeFile(
        java,
        [
          '#!/bin/sh',
          `if [ "$1" = "-XshowSettings:properties" ]; then printf 'java.version = 21.0.1\\nos.arch = ${probe}\\n'; exit 0; fi`,
          'printf "Java fixture started\\n%s\\n" "$@"',
          'exec sleep 20',
        ].join('\n'),
        { mode: 0o700 },
      );
      await mkdir(join(directory, 'wrong'));
      await writeFile(wrongJava, `#!/bin/sh\nprintf 'java.version = 17.0.1\\nos.arch = ${probe}\\n'\n`, {
        mode: 0o700,
      });
      host = await createLauncherHost({
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://rezics.example.test',
        launcherVersion: '0.1.0',
        minecraftClientId: 'approved-app-fixture',
        fetch: fetcher,
        openExternal: async () => {},
        automation: { onInstalledChanged: () => created.push('changed') },
      });
      expect(await cli('minecraft-versions')).toEqual([{ id: version, latest: true }]);
      expect(await cli('minecraft-loaders', { version, loader: 'fabric' })).toEqual([{ id: '0.16.14', stable: true }]);
      const { id: instanceId } = await cli('create-minecraft', {
        name: 'CLI Minecraft fixture',
        loader: 'vanilla',
        version,
      });
      expect(await cli('check-minecraft-java', instanceId)).toEqual({
        version,
        requiredMajor: 21,
        state: 'needs-preparation',
        policy: 'managed',
      });
      await cli('set-minecraft-java', { instanceId, executable: wrongJava }, /requires Java 21.*runtime is Java 17/);
      metadataAvailable = false;
      await cli('set-minecraft-java', { instanceId, executable: java }, /Could not read the Java requirement/);
      metadataAvailable = true;
      expect((await cli('list-installed'))[0].minecraft.settings).toBeUndefined();
      await cli('set-minecraft-java', { instanceId, executable: java });
      const checked = await cli('check-minecraft-java', instanceId);
      expect(checked).toEqual({
        version,
        requiredMajor: 21,
        state: 'ready',
        policy: 'custom',
        major: 21,
        architecture: process.arch,
      });
      const initial = await cli('prepare-minecraft', { instanceId, mode: 'install' });
      await observe(() => host!.core.readMinecraftPreparation(instanceId), 'phase', 'assets');
      expect(await cli('minecraft-preparation', instanceId)).toMatchObject({
        id: initial.id,
        phase: 'assets',
        progress: { completed: 1, total: 2 },
      });
      await cli('cancel-minecraft-preparation', { instanceId, attemptId: 'stale' });
      expect(await cli('minecraft-preparation', instanceId)).toMatchObject({ id: initial.id, state: 'running' });
      await cli('cancel-minecraft-preparation', { instanceId, attemptId: initial.id });
      await observe(() => host!.core.readMinecraftPreparation(instanceId), 'state', 'cancelled');
      const repaired = await cli('prepare-minecraft', { instanceId, mode: 'repair' });
      await observe(() => host!.core.readMinecraftPreparation(instanceId), 'state', 'ready');
      expect(await cli('minecraft-preparation', instanceId)).toMatchObject({ id: repaired.id, state: 'ready' });
      metadataAvailable = false;
      expect(await cli('check-minecraft-java', instanceId)).toEqual(checked);
      await cli('start-game', instanceId, /Sign in again or choose a saved Minecraft profile/);

      const code = await cli('start-minecraft-sign-in', {});
      expect(code).toMatchObject({
        state: 'waiting',
        device: { code: 'FIXTURE-PUBLIC', url: 'https://www.microsoft.com/link' },
      });
      expect(await cli('minecraft-sign-in-status')).toEqual(code);
      expect(await cli('cancel-minecraft-sign-in')).toEqual({ state: 'idle' });
      expect(await cli('minecraft-accounts')).toEqual({ activeId: null, profiles: [], persistent: false });
      await cli('start-minecraft-sign-in', {});
      approved = true;
      await observe(() => host!.core.readMinecraftSignIn(), 'state', 'signed-in');
      expect(await cli('minecraft-sign-in-status')).toEqual({ state: 'signed-in' });
      const accounts = await cli('minecraft-accounts');
      expect(accounts).toMatchObject({
        activeId: 'fixture-profile',
        profiles: [{ name: 'FixturePlayer', state: 'ready' }],
      });
      await cli('set-minecraft-settings', { instanceId, accountId: 'fixture-profile', maxMemoryMiB: 2048 });
      expect(created).toHaveLength(3);
      const session = await cli('start-game', instanceId);
      expect((await cli('game-status')).session).toMatchObject({ sessionId: session.sessionId, instanceId });
      await cli('stop-game', session.sessionId);
      await host.core.waitForGameWork();
      expect(await cli('launch-log', instanceId)).toContain('Java fixture started');
      await rm(java);
      expect(await cli('check-minecraft-java', instanceId, undefined, true)).toMatchObject({
        version,
        requiredMajor: 21,
        state: 'invalid',
        policy: 'custom',
        action: 'settings',
      });
      expect(await cli('forget-minecraft-account', 'fixture-profile')).toMatchObject({ activeId: null, profiles: [] });
    } finally {
      const active = await host?.core.currentSession();
      if (active) await host!.core.stopGame(active.sessionId).catch(() => {});
      if (host) {
        for (const item of await host.core.activeMinecraftPreparations()) {
          await host.core.cancelMinecraftPreparation(item.instanceId, item.id);
        }
      }
      await host?.close();
      prepare.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
