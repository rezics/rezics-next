import { bundledPluginManifests } from '@rezics/launcher-contract';
import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLauncherHost } from './host';

const script = resolve(import.meta.dir, '../../scripts/host.ts');

async function run(args: string[], stdin?: Buffer) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(10_000),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('the executable advertises its declared plugin commands and argument forms without a profile', async () => {
  const result = await run(['--commands']);
  const help = await run(['--help']);
  expect(result.code, result.stderr).toBe(0);
  expect(help.code, help.stderr).toBe(0);
  const description = JSON.parse(result.stdout);
  expect(description.schemaVersion).toBe(1);
  const commands = new Map<string, { input: string; runningHost?: boolean; plugin?: string }>(
    description.commands.map((command: { name: string }) => [command.name, command]),
  );
  expect(commands.size).toBe(description.commands.length);
  for (const plugin of Object.values(bundledPluginManifests)) {
    for (const [name, declaration] of Object.entries(plugin.hostCommands)) {
      expect(commands.get(name)).toMatchObject({ ...declaration, plugin: plugin.id });
    }
  }
  expect(commands.get('read-library')).toMatchObject({ input: 'json', stdin: 'credential' });
  expect(commands.get('inspect-vn')).toMatchObject({ input: 'json-with-base', stdin: 'json' });
  expect(commands.get('link-vn')).toMatchObject({ input: 'json', stdin: 'json' });
  expect(commands.get('serve')).toMatchObject({ input: 'none' });
  expect(commands.get('start-game')).toMatchObject({ input: 'text', runningHost: true });
  expect(help.stdout).toContain('  export-footprints <file>');
  expect(help.stdout).toContain('  discover-vn <folder>');
});

test('rejects invalid, oversized and unsupported standard input before opening a profile', async () => {
  const scratch = resolve(import.meta.dir, '../../.temp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'automation-stdin-'));
  const profile = join(root, 'profile');
  try {
    for (const [command, input, message] of [
      ['import-vn', Buffer.from('[][private title]'), /Supply one UTF-8 JSON value/],
      ['inspect-vn', Buffer.alloc(16 * 1024 * 1024 + 1, ' '), /JSON input is too large/],
      ['read-library', Buffer.from('private credential'), /Supply a Library query file/],
    ] as const) {
      const result = await run(['--data-dir', profile, command, '-'], input);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(message);
      expect(result.stderr).not.toContain('private');
    }
    await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'opts in through the owning host and exports only completed opted-in sessions',
  async () => {
    const scratch = resolve(import.meta.dir, '../../.temp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'automation-footprints-'));
    const dataDir = join(root, 'profile');
    const file = join(root, 'Footprints command.json');
    const changes: string[] = [];
    let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;
    const subjectId = '018943aa-abcd-4abc-9abc-0123456789ab';
    const executable = join(root, 'fixture.sh');

    async function cli(command: string, argument?: string | object, failure?: RegExp) {
      const input = typeof argument === 'object' ? file : argument;
      if (typeof argument === 'object') await writeFile(file, JSON.stringify(argument));
      const { code, stdout, stderr } = await run(['--data-dir', dataDir, command, ...(input ? [input] : [])]);
      expect(code, stderr).toBe(failure ? 1 : 0);
      if (failure) {
        expect(stderr).toMatch(failure);
        expect(stdout).toBe('');
        return;
      }
      return JSON.parse(stdout);
    }

    async function exported(path: string) {
      expect(await cli('export-footprints', { file: path })).toEqual({ file: path });
      return (await readFile(path, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
    }

    try {
      host = await createLauncherHost({
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://site.example.test',
        launcherVersion: '0.1.0',
        openExternal: async () => {},
        automation: { onFootprintRecordingChanged: () => changes.push('changed') },
      });
      await writeFile(executable, '#!/bin/sh\nexec sleep 40\n', { mode: 0o700 });
      const game = await host.core.importInstance({ kind: 'local', name: 'Footprints fixture', executable, subjectId });
      expect(await cli('footprint-status')).toEqual({ enabled: false, error: null });
      await cli('set-footprint-recording', { enabled: 'true' }, /Choose whether/);
      const before = await cli('start-game', game.id);
      expect(await cli('set-footprint-recording', { enabled: true })).toEqual({ enabled: true, error: null });
      await cli('stop-game', before.sessionId);
      await host.core.waitForGameWork();

      const live = await cli('start-game', game.id);
      const header = { format: 'rezics-launcher-footprints', version: 1 };
      expect(await exported(join(root, 'During a run.jsonl'))).toEqual([header]);
      await cli('stop-game', live.sessionId);
      await host.core.waitForGameWork();
      const destination = join(root, 'Completed runs.jsonl');
      expect(await exported(destination)).toEqual([
        header,
        expect.objectContaining({ originId: live.sessionId, targetId: subjectId }),
      ]);
      await cli('export-footprints', { file: 'relative.jsonl' }, /absolute .jsonl/);
      const beforeRetry = await readFile(destination);
      await cli('export-footprints', { file: destination }, /already a file/);
      expect(await readFile(destination)).toEqual(beforeRetry);
      expect(await cli('set-footprint-recording', { enabled: false })).toEqual({ enabled: false, error: null });
      expect(changes).toEqual(['changed', 'changed']);
    } finally {
      const session = await host?.core.currentSession();
      if (session) await host?.core.stopGame(session.sessionId).catch(() => {});
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
