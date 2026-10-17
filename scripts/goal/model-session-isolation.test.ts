import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('tests without a settings helper cannot reach inherited account launchers or session stores', () => {
  const parent = join(import.meta.dir, '../../.temp/model-session-isolation');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-'));
  const terminal = mkdtempSync(join(tmpdir(), 'model-session-isolation-'));
  const socket = join(terminal, 'tmux.sock');
  const machine = join(directory, 'machine');
  const bin = join(machine, 'bin');
  const settings = join(machine, '.goalctl');
  const sessions = join(machine, 'sessions');
  mkdirSync(bin, { recursive: true }); mkdirSync(settings); mkdirSync(sessions);
  const launcher = join(bin, 'codex');
  writeFileSync(launcher, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(sessions, 'launched'))}, 'a host model launcher ran');\n`);
  chmodSync(launcher, 0o755);
  const accounts = ['codex', 'host-account'].map(engine => ({ engine, launcher, home: join(machine, engine), weight: 1 }));
  for (const account of accounts) mkdirSync(account.home);
  writeFileSync(join(settings, 'settings.user.json'), JSON.stringify({ version: 1, accounts }));
  const childTest = join(directory, 'omitted-helper.test.ts');
  writeFileSync(childTest, `import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredAccounts, loadSettings } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
import { launchCommand } from ${JSON.stringify(join(import.meta.dir, 'launch.ts'))};
import { engineEnv, engineNames } from ${JSON.stringify(join(import.meta.dir, 'types.ts'))};
import { dispatchEngine } from ${JSON.stringify(join(import.meta.dir, 'handover.ts'))};
import { coordinatorStartDescriptor, coordinatorStartOptions } from ${JSON.stringify(join(import.meta.dir, 'manager-commands.ts'))};
import { reviewBranch, reviewEngines } from ${JSON.stringify(join(import.meta.dir, 'land.ts'))};
test('worker, resume and reviewer launches stay inside the test fixture', async () => {
  expect(loadSettings().directory).not.toBe(${JSON.stringify(settings)});
  const accounts = configuredAccounts();
  expect(accounts.length).toBeGreaterThan(0);
  for (const account of accounts) {
    expect(account.home).toBeTruthy();
    expect(account.home.startsWith(${JSON.stringify(machine)})).toBe(false);
  }
  let launches = 0;
  for (const name of engineNames()) {
    const engine = dispatchEngine(name);
    for (const resume of [false, true]) {
      const [program, args] = launchCommand({ id: 'worker', engine, resume, effort: 'high',
        session: 'recording-session', prompt: '--- recording prompt', worktree: ${JSON.stringify(directory)} });
      expect(Bun.which(program, { PATH: process.env.PATH }).startsWith(${JSON.stringify(bin)})).toBe(false);
      const child = spawnSync(program, args, { cwd: ${JSON.stringify(directory)}, encoding: 'utf8',
        env: { ...process.env, ...engineEnv(engine) } });
      expect(child.status, child.stderr).toBe(0);
      launches++;
    }
  }
  for (const engine of [...accounts.map(account => account.engine), 'claude']) {
    const descriptor = coordinatorStartDescriptor(coordinatorStartOptions(['program', '--engine', engine, '--effort', 'high']),
      ${JSON.stringify(directory)}, ${JSON.stringify(socket)});
    expect(descriptor.program.startsWith(${JSON.stringify(bin)})).toBe(false);
    const child = spawnSync(descriptor.program, descriptor.startArgs, { cwd: descriptor.cwd,
      encoding: 'utf8', env: { ...process.env, ...descriptor.env } });
    expect(child.status, child.stderr).toBe(0);
    launches++;
  }
  for (const engine of reviewEngines()) {
    expect(await reviewBranch({ worktree: ${JSON.stringify(directory)}, base: 'HEAD', head: 'HEAD',
      brief: 'Fixture review', handoff: 'RESULT: done', directory: join(${JSON.stringify(directory)}, 'review-' + engine) }, engine)).toEqual([]);
    launches++;
  }
  const records = readFileSync(process.env.GOAL_TEST_LAUNCH_LOG, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(launches);
  expect(new Set(records.map(record => record.program))).toEqual(new Set(['codex', 'claude', 'grok', 'cursor-agent']));
  expect(records.every(record => record.codexHome === process.env.CODEX_HOME && record.claudeHome === process.env.CLAUDE_CONFIG_DIR)).toBe(true);
  expect(records.some(record => record.args.includes('--- recording prompt'))).toBe(true);
  expect(records.some(record => record.input.includes('Fixture review'))).toBe(true);
});\n`);
  try {
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=Isolation test', '-c', 'user.email=isolation@example.invalid',
      'commit', '--allow-empty', '-qm', 'Fixture'], { cwd: directory }).status).toBe(0);
    expect(spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'fixture']).status).toBe(0);
    const child = spawnSync(process.execPath, ['test', '--timeout=30000', childTest], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 60_000, env: { ...process.env,
        // All of these can arrive from a manager session; the preload must replace them before imports.
        GOAL_SETTINGS_DIRECTORY: settings, GOAL_CODEX_HOME: accounts[0]!.home, CODEX_HOME: accounts[0]!.home,
        CLAUDE_CONFIG_DIR: join(machine, 'claude'), PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'production' },
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(existsSync(join(sessions, 'launched'))).toBe(false);
    expect(readFileSync(join(settings, 'settings.user.json'), 'utf8')).toBe(JSON.stringify({ version: 1, accounts }));
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    rmSync(terminal, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
