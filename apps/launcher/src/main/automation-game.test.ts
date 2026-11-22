import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createLauncherHost } from './host';

test.skipIf(process.platform === 'win32')(
  'controls a running game and its overlay through the host command',
  async () => {
    const temp = resolve(import.meta.dir, '../../.temp');
    await mkdir(temp, { recursive: true });
    const root = await mkdtemp(join(temp, 'automation-game-'));
    const dataDir = join(root, 'profile');
    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    const game = join(root, 'game.sh');
    const sidecar = join(root, 'overlay.mjs');
    const sidecarLog = join(root, 'overlay-starts.log');
    const changes: string[] = [];
    const launchReports: string[] = [];
    let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

    async function cli(command: string, argument?: string, failure?: RegExp, partial = false) {
      const child = Bun.spawn(
        [process.execPath, script, '--data-dir', dataDir, command, ...(argument ? [argument] : [])],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          signal: AbortSignal.timeout(8_000),
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(failure ? 1 : partial ? 2 : 0);
      if (failure) {
        expect(stderr).toMatch(failure);
        expect(stdout).toBe('');
        return;
      }
      return JSON.parse(stdout);
    }

    async function waitFor(ready: () => boolean) {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (ready()) return;
        await setTimeout(25);
      }
      throw new Error('The game or Overlay did not reach the expected state.');
    }

    try {
      await cli('start-game', 'fixture', /start the terminal host with serve/);
      await writeFile(join(dataDir, 'overlay-preferences.json'), JSON.stringify({ shortcut: 'ctrl-shift-f10' }));
      expect(await cli('overlay-preferences')).toEqual({ enabled: true, shortcut: 'ctrl-shift-f10' });
      const preferences = join(root, 'overlay-preferences-request.json');
      await writeFile(preferences, JSON.stringify({ enabled: 'false' }));
      await cli('set-overlay-preferences', preferences, /Choose whether Overlay starts with games/);
      await writeFile(preferences, JSON.stringify({ enabled: false }));
      expect(await cli('set-overlay-preferences', preferences)).toEqual({ enabled: false, shortcut: 'ctrl-shift-f10' });
      await writeFile(
        game,
        '#!/bin/sh\nprintf "Fixture ready\\nAuthorization: Bearer diagnostic-fixture-value\\n"\nexec sleep 30\n',
        { mode: 0o700 },
      );
      await writeFile(
        sidecar,
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(sidecarLog)}, 'started\\n');
const send = (message) => console.log(JSON.stringify({ v: 1, ...message }));
send({ type: 'ready', shortcut: process.argv[3] });
createInterface({ input: process.stdin }).on('line', (line) => {
  const { sessionId } = JSON.parse(line).session;
  send({ type: 'session-status', sessionId, attached: true });
});`,
        { mode: 0o700 },
      );
      host = await createLauncherHost({
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://rezics.example.test',
        launcherVersion: '0.1.0',
        overlayExecutable: sidecar,
        openExternal: async () => {},
        automation: { onSaveHistoryChanged: (id) => changes.push(id) },
      });
      host.core.subscribeLaunchReport((id) => launchReports.push(id));
      const importRequest = join(root, 'local-game.json');
      await writeFile(importRequest, JSON.stringify({ name: 'Game fixture', executable: game }));
      const instance = await cli('import-local-game', importRequest);
      const snapshots = join(dataDir, 'instances', instance.id, 'snapshots');
      const saves = join(root, 'saves');
      await mkdir(saves);
      const slot = join(saves, 'slot.save');
      await writeFile(slot, 'previous progress');
      await writeFile(snapshots, 'obstructed snapshot folder');
      expect(await cli('launch-report', instance.id)).toBeNull();
      expect(await cli('read-automatic-backups', await instanceRows(instance.id))).toMatchObject([
        { status: 'ready', backup: { state: 'idle' } },
      ]);
      const session = await cli('start-game', instance.id);
      expect((await cli('game-status')).overlay).toEqual({
        state: 'disabled',
        sessionId: session.sessionId,
        shortcut: 'ctrl-shift-f10',
      });
      await expect(readFile(sidecarLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(preferences, JSON.stringify({ enabled: true }));
      await cli('set-overlay-preferences', preferences);
      await waitFor(() => host!.overlay.status().state === 'ready');
      expect(await cli('game-status')).toMatchObject({
        work: 'playing',
        session: { sessionId: session.sessionId, instanceId: instance.id },
        overlay: { state: 'ready', sessionId: session.sessionId, shortcut: 'ctrl-shift-f10' },
      });
      expect(await cli('launch-report', instance.id)).toEqual({
        state: 'running',
        exitCode: null,
        signal: null,
        issue: null,
      });
      expect(launchReports).toEqual([]);
      await cli('quit-host', undefined, /Use quit-host with a terminal host started by serve/);
      await cli('retry-automatic-backup', instance.id, /Close the game/);
      const archiveRequest = join(root, 'archive.json');
      await writeFile(archiveRequest, JSON.stringify([{ instanceId: instance.id }]));
      expect(await cli('archive-local-games', archiveRequest, undefined, true)).toMatchObject([
        { status: 'error', instanceId: instance.id, message: 'Close the game before changing this instance.' },
      ]);
      await cli('stop-game', 'old-session', /no longer running/);
      await cli('restart-overlay', 'old-session', /has ended/);
      const request = join(root, 'shortcut.json');
      await writeFile(request, JSON.stringify({ sessionId: session.sessionId, shortcut: 'ctrl-shift-f9' }));
      await cli('set-overlay-shortcut', request);
      await waitFor(() => host!.overlay.status().state === 'ready');
      expect((await cli('game-status')).overlay).toMatchObject({ state: 'ready', shortcut: 'ctrl-shift-f9' });
      await writeFile(preferences, JSON.stringify({ enabled: false }));
      await cli('set-overlay-preferences', preferences);
      expect(await cli('game-status')).toMatchObject({
        work: 'playing',
        session: { sessionId: session.sessionId, pid: session.pid },
        overlay: { state: 'disabled', shortcut: 'ctrl-shift-f9' },
      });
      await cli('restart-overlay', session.sessionId, /Enable Overlay/);
      await writeFile(preferences, JSON.stringify({ enabled: true }));
      await cli('set-overlay-preferences', preferences);
      await waitFor(() => host!.overlay.status().state === 'ready');
      await cli('restart-overlay', session.sessionId);
      await waitFor(() => host!.overlay.status().state === 'ready');
      expect(await cli('stop-game', session.sessionId)).toEqual({ status: 'stopped', sessionId: session.sessionId });
      await host.core.waitForGameWork();
      expect(await cli('game-status')).toEqual({ work: 'idle', session: null, overlay: { state: 'inactive' } });
      const diagnostic = await cli('launch-log', instance.id);
      expect(diagnostic).toContain('Fixture ready');
      expect(diagnostic).not.toContain('diagnostic-fixture-value');
      const report = await cli('launch-report', instance.id);
      expect(report).toMatchObject({ state: 'exited', issue: null });
      expect(launchReports).toEqual([instance.id]);
      const rows = await instanceRows(instance.id, 'missing');
      const failed = await cli('read-automatic-backups', rows, undefined, true);
      expect(failed).toMatchObject([
        { index: 0, instanceId: instance.id, status: 'ready', backup: { state: 'failed' } },
        { index: 1, instanceId: 'missing', status: 'error' },
      ]);
      expect(failed[0].backup.message).toContain('snapshots folder');
      await cli('retry-automatic-backup', 'missing', /instance does not exist/);
      await rm(snapshots);
      const backup = await cli('retry-automatic-backup', instance.id);
      expect(backup).toMatchObject({ label: 'Automatic backup', files: 1 });
      expect(await cli('retry-automatic-backup', instance.id)).toEqual(backup);
      expect(changes).toEqual([instance.id, instance.id]);
      expect(await cli('list-backups', instance.id)).toEqual([backup]);
      expect(await readFile(slot, 'utf8')).toBe('previous progress');
      expect(await cli('archive-local-games', archiveRequest)).toMatchObject([{ status: 'archived', instance }]);
      const unavailable = await cli('read-automatic-backups', rows, undefined, true);
      expect(unavailable.map(({ status }: { status: string }) => status)).toEqual(['error', 'error']);
      await cli('import-local-game', importRequest, /This installation is archived/);
      expect(await cli('restore-archived-local-games', archiveRequest)).toMatchObject([
        { status: 'restored', instance },
      ]);
      expect(await cli('launch-log', instance.id)).toBe(diagnostic);
      await rm(game);
      await cli('start-game', instance.id, /selected game executable could not be started/);
      expect(await cli('launch-report', instance.id)).toMatchObject({
        state: 'failed',
        issue: { kind: 'executable', action: 'none' },
      });
      expect(launchReports).toEqual([instance.id, instance.id]);
      await host.close();
      host = undefined;
      expect(await cli('overlay-preferences')).toEqual({ enabled: true, shortcut: 'ctrl-shift-f9' });
      expect(await cli('read-automatic-backups', rows, undefined, true)).toMatchObject([
        { status: 'ready', backup: { state: 'idle' } },
        { status: 'error' },
      ]);
    } finally {
      const session = await host?.core.currentSession();
      if (session) await host!.core.stopGame(session.sessionId).catch(() => {});
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }

    async function instanceRows(...ids: string[]) {
      const file = join(root, 'instances.json');
      await writeFile(file, JSON.stringify(ids.map((instanceId) => ({ instanceId }))));
      return file;
    }
  },
  20_000,
);
