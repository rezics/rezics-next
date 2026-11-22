import type { MinecraftPreparation, Session } from '@rezics/launcher-contract';
import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Minecraft } from '../../../../packages/launcher-core/src/minecraft';
import type { AutomationRequest } from './automation-commands';
import { sendAutomation } from './automation-transport';
import { createLauncherHost, LauncherProfileBusyError } from './host';

test.skipIf(process.platform === 'win32')(
  'finishes a terminal quit while keeping the exact game controllable and the profile owned',
  async () => {
    const temporary = resolve(import.meta.dir, '../../.temp');
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, 'automation-terminal-quit-'));
    const dataDir = join(root, 'profile');
    const record = join(root, 'import.json');
    const saves = join(root, 'saves');
    const slot = join(saves, 'current.save');
    const game = join(root, 'game.sh');
    const sidecar = join(root, 'overlay.mjs');
    const overlayLog = join(root, 'overlay.log');
    const releaseOverlay = join(root, 'release-overlay');
    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    const command = [process.execPath, script, '--data-dir', dataDir];
    const env = { ...process.env, REZICS_OVERLAY_PATH: sidecar };
    let server: ReturnType<typeof serve> | undefined;
    let session: Session | undefined;

    function serve() {
      return Bun.spawn([...command, 'serve'], { env, stdout: 'pipe', stderr: 'inherit' });
    }

    async function cli(name: string, argument?: string, failure?: RegExp) {
      const child = Bun.spawn([...command, name, ...(argument ? [argument] : [])], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(8_000),
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

    async function waitFor<T>(observe: () => Promise<T | false>): Promise<T> {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const value = await observe();
        if (value !== false) return value;
        await setTimeout(20);
      }
      throw new Error('The terminal host did not reach the expected state.');
    }

    async function openTerminal() {
      const child = serve();
      server = child;
      const reader = child.stdout.getReader();
      try {
        const { value } = await Promise.race([
          reader.read(),
          setTimeout(8_000, undefined, { ref: false }).then(() => {
            throw new Error('The terminal host did not announce readiness.');
          }),
        ]);
        expect(JSON.parse(new TextDecoder().decode(value))).toEqual({ status: 'ready' });
      } finally {
        reader.releaseLock();
      }
      return child;
    }

    try {
      await mkdir(saves);
      await writeFile(game, '#!/bin/sh\nprintf "Owned game output\\n"\nexec sleep 120\n', { mode: 0o700 });
      await writeFile(
        sidecar,
        `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (value) => appendFileSync(${JSON.stringify(overlayLog)}, value + '\\n');
const send = (message) => console.log(JSON.stringify({ v: 1, ...message }));
send({ type: 'ready' });
createInterface({ input: process.stdin }).on('line', (line) => {
  send({ type: 'session-status', sessionId: JSON.parse(line).session.sessionId, attached: true });
});
process.stdin.on('end', () => {
  log('retiring');
  const hold = setInterval(() => {
    if (!existsSync(${JSON.stringify(releaseOverlay)})) return;
    clearInterval(hold);
    log('retired');
  }, 15);
});`,
        { mode: 0o700 },
      );
      await writeFile(record, JSON.stringify({ name: 'Terminal game', executable: game, saveDirectory: saves }));
      const instance = await cli('import-local-game', record);
      await cli('quit-host', undefined, /start the terminal host with serve/i);
      const settings = {
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://rezics.example.test',
        launcherVersion: '0.1.0',
        openExternal: async () => {},
      };

      for (const method of ['command', 'signal']) {
        await writeFile(overlayLog, '');
        await rm(releaseOverlay, { force: true });
        await writeFile(slot, method);
        const terminal = await openTerminal();
        const playing: Session = await cli('start-game', instance.id);
        session = playing;
        await waitFor(async () => (await cli('game-status')).overlay.state === 'ready');
        if (method === 'command') {
          expect(await cli('quit-host')).toEqual({ status: 'quitting' });
        } else {
          terminal.kill('SIGTERM');
        }

        const waiting = await waitFor(async () => {
          const status = await cli('game-status');
          return status.quitPending === true ? status : false;
        });
        expect(waiting).toMatchObject({
          work: 'playing',
          session: { sessionId: playing.sessionId, pid: playing.pid },
          overlay: { state: 'ready', sessionId: playing.sessionId },
        });
        terminal.kill('SIGTERM');
        expect(await cli('quit-host')).toEqual({ status: 'quitting' });
        await cli('start-game', instance.id, /terminal host is waiting to quit/);
        await cli('import-local-game', record, /terminal host is waiting to quit/);
        expect(await cli('list-installed')).toEqual([instance]);
        expect(await cli('launch-report', instance.id)).toMatchObject({ state: 'running' });
        await cli('stop-game', 'old-session', /no longer running/);
        expect(await cli('stop-game', playing.sessionId)).toEqual({
          status: 'stopped',
          sessionId: playing.sessionId,
        });
        session = undefined;

        await waitFor(async () => (await readFile(overlayLog, 'utf8')).includes('retiring'));
        await expect(createLauncherHost(settings).then((listener) => listener.close())).rejects.toBeInstanceOf(
          LauncherProfileBusyError,
        );
        expect(terminal.exitCode).toBeNull();
        await writeFile(releaseOverlay, '');
        expect(await terminal.exited).toBe(0);
        server = undefined;
        expect(await readFile(overlayLog, 'utf8')).toBe('retiring\nretired\n');
        await expect(readFile(join(dataDir, 'automation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await cli('launch-log', instance.id)).toContain('Owned game output');
        expect((await cli('list-backups', instance.id)).length).toBe(method === 'command' ? 1 : 2);
        expect(await readFile(slot, 'utf8')).toBe(method);
      }

      const idle = await openTerminal();
      expect(await cli('quit-host')).toEqual({ status: 'quitting' });
      expect(await idle.exited).toBe(0);
      server = undefined;
    } finally {
      if (session) {
        try {
          process.kill(session.pid, 'SIGTERM');
        } catch {
          // The game may already have exited.
        }
      }
      if (server && server.exitCode === null) {
        await writeFile(releaseOverlay, '');
        server.kill('SIGTERM');
        await Promise.race([server.exited, setTimeout(5_000, undefined, { ref: false })]);
        if (server.exitCode === null) {
          server.kill('SIGKILL');
          await server.exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);

test('keeps a preparation accepted before terminal quit visible and cancellable by attempt ID', async () => {
  const temporary = resolve(import.meta.dir, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'automation-preparation-quit-'));
  const settings = {
    dataDir: root,
    catalogUrl: 'https://catalog.example.test',
    webUrl: 'https://rezics.example.test',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
  };
  const quit = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<void>();
  const preparing = Promise.withResolvers<void>();
  const cleanup = new AbortController();
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockImplementation(async (_selection, job) => {
    await job.report('assets', { completed: 1, total: 2 });
    preparing.resolve();
    await setTimeout(30_000, undefined, { signal: AbortSignal.any([job.signal, cleanup.signal]) });
    throw new Error('Expected a cancelled preparation.');
  });
  const request = (command: AutomationRequest['command'], argument?: unknown) =>
    sendAutomation(root, { command, argument }, AbortSignal.timeout(8_000)).then(({ value }) => value);
  try {
    const current = await createLauncherHost({ ...settings, automation: { onTerminalQuit: quit.resolve } });
    host = current;
    const drained = quit.promise.then(async () => {
      await current.waitForTerminalWork();
      await current.close();
    });
    void drained.catch(() => {});
    const game = await current.core.createMinecraft({ name: 'Queued at quit', loader: 'vanilla' });
    const start = current.core.startMinecraftPreparation;
    current.core.startMinecraftPreparation = async (instanceId, mode) => {
      entered.resolve();
      await admit.promise;
      return start(instanceId, mode);
    };
    const input = { instanceId: game.id, mode: 'install' };
    const accepted = request('prepare-minecraft', input) as Promise<MinecraftPreparation>;
    await Promise.race([entered.promise, accepted]);
    expect(await request('quit-host')).toEqual({ status: 'quitting' });
    expect(await request('game-status')).toMatchObject({ work: 'idle', quitPending: true });
    await expect(request('prepare-minecraft', input)).rejects.toThrow('terminal host is waiting to quit');
    admit.resolve();

    const attempt = await accepted;
    await preparing.promise;
    expect(await request('minecraft-preparation', game.id)).toMatchObject({
      id: attempt.id,
      phase: 'assets',
      progress: { completed: 1, total: 2 },
    });
    await request('cancel-minecraft-preparation', { instanceId: game.id, attemptId: 'stale' });
    expect(await request('minecraft-preparation', game.id)).toMatchObject({ id: attempt.id, state: 'running' });
    await request('cancel-minecraft-preparation', { instanceId: game.id, attemptId: attempt.id });
    await drained;
    host = await createLauncherHost(settings);
    expect(await host.core.readMinecraftPreparation(game.id)).toMatchObject({ id: attempt.id, state: 'cancelled' });
  } finally {
    admit.resolve();
    cleanup.abort();
    await host?.close();
    prepare.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
