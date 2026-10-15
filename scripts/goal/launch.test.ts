import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testAccountSettings } from './fixtures/accounts.ts';

test('dispatch, resume and resident coordinator worker wakes read current layered compaction limits', () => {
  const parent = join(import.meta.dir, '../../.temp/launch');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'compaction-'));
  const launcher = join(dir, 'codex');
  const captured = join(dir, 'args.json');
  const settings = testAccountSettings(dir, [{ engine: 'codex', launcher, home: join(dir, 'home') }]);
  writeFileSync(launcher, `#!/usr/bin/env bun
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args));
    writeFileSync(args[args.indexOf('-o') + 1], 'RESULT: parked');
  `);
  chmodSync(launcher, 0o755);
  try {
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir }).status).toBe(0);
    const child = spawnSync(process.execPath, ['-e', `
      import { expect } from 'bun:test';
      import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
      import { launch, launchCommand } from ${JSON.stringify(join(import.meta.dir, 'launch.ts'))};
      import { coordinateWorkerJobs } from ${JSON.stringify(join(import.meta.dir, 'coordinator.ts'))};
      import { JobStore, jobDirectory } from ${JSON.stringify(join(import.meta.dir, 'job.ts'))};
      const settings = ${JSON.stringify(settings)};
      const captured = ${JSON.stringify(captured)};
      const shared = sol => writeFileSync(settings + '/settings.json', JSON.stringify({ version: 1,
        codexCompactTokens: { sol, luna: 210000 } }));
      shared(160000);
      const task = { id: 'worker', worktree: process.cwd(), state: 'exited', effort: 'high', engine: 'codex', attempts: [] };
      const ledger = { tasks: { worker: task } };
      const wait = async limit => {
        const deadline = Date.now() + 5000;
        while (!existsSync(captured) && Date.now() < deadline) await Bun.sleep(10);
        const args = JSON.parse(readFileSync(captured, 'utf8'));
        expect(args).toContain('model_auto_compact_token_limit=' + limit);
        return args;
      };
      const first = launch(task, 'high', 'native-session', 'dispatch', false, 'manager', 'codex');
      task.attempts.push(first);
      expect((await wait(160000))[0]).toBe('exec');
      rmSync(captured);
      shared(170000);
      const second = launch(task, 'high', 'native-session', 'resume', true, 'manager', 'codex');
      task.attempts.push(second);
      expect((await wait(170000)).slice(0, 3)).toEqual(['exec', 'resume', 'native-session']);
      // Keep the coordinator module resident while both settings layers change.
      shared(180000);
      writeFileSync(settings + '/settings.user.json', JSON.stringify({ version: 1,
        accounts: [{ engine: 'codex', launcher: ${JSON.stringify(launcher)}, home: settings + '/home', weight: 1 }],
        codexCompactTokens: { sol: 190000, luna: 220000 } }));
      // The native process must exit before its parked job can wake it.
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(second.pid, 0); } catch { break; }
        if (Date.now() > deadline) throw new Error('fixture worker did not exit');
        await Bun.sleep(10);
      }
      rmSync(captured);
      const store = new JobStore(jobDirectory(process.cwd()));
      try {
        store.put({ id: 'complete', task: 'worker', attempt: 2, cwd: process.cwd(), command: ['fixture'],
          created: Date.now(), phase: 'parked', code: 0, ended: Date.now() });
        await coordinateWorkerJobs(ledger, { mutate: async work => work(ledger), admit: () => ({}) });
        expect(store.get('complete').phase).toBe('woken');
        expect((await wait(190000)).slice(0, 3)).toEqual(['exec', 'resume', 'native-session']);
      } finally { store.close(); }
      for (const engine of ['codex', 'luna']) {
        const command = () => launchCommand({ id: 'worker', engine, effort: 'high', session: 'native-session',
          prompt: 'p', resume: true })[1];
        expect(command()).toContain('model_auto_compact_token_limit=' + (engine === 'luna' ? 220000 : 190000));
        process.env.GOAL_CODEX_COMPACT_TOKENS = '120000';
        expect(command()).toContain('model_auto_compact_token_limit=120000');
        delete process.env.GOAL_CODEX_COMPACT_TOKENS;
      }
    `], { cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...process.env,
      GOAL_SETTINGS_DIRECTORY: settings, GOAL_CODEX_COMPACT_TOKENS: '',
    } });
    expect(child.status, child.stderr).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function commands(configs: [string | undefined, string | undefined]) {
  const parent = join(import.meta.dir, '../../.temp/launch');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'c-'));
  const homes = [join(dir, 'codex'), join(dir, 'sample-b')];
  const settingsDirectory = testAccountSettings(dir, [
    { engine: 'codex', home: homes[0] }, { engine: 'sample-b', home: homes[1] },
  ]);
  const socket = join(dir, 'tmux.sock');
  try {
    const tmux = spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'fixture'], { encoding: 'utf8' });
    expect(tmux.status).toBe(0);
    for (const [index, home] of homes.entries()) {
      mkdirSync(home);
      if (configs[index] !== undefined) writeFileSync(join(home, 'config.toml'), configs[index]!);
    }
    // Account homes are resolved at module load: isolate them without changing this test process.
    const child = spawnSync(process.execPath, ['--eval', `
      import { launchCommand } from './scripts/goal/launch.ts';
      import { coordinatorStartDescriptor, coordinatorStartOptions } from './scripts/goal/manager-commands.ts';
      console.log(JSON.stringify(['codex', 'sample-b', 'luna'].map(engine => {
        const worker = resume => launchCommand({ id: 'worker', engine, effort: 'high', session: 'session',
          prompt: '--- brief', resume, worktree: ${JSON.stringify(dir)} });
        const manager = engine === 'luna' ? null : coordinatorStartDescriptor(
          coordinatorStartOptions(['program', '--engine', engine, '--effort', 'high']),
          ${JSON.stringify(dir)}, ${JSON.stringify(socket)});
        return { engine, fresh: worker(false), resume: worker(true), manager };
      })));
    `], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: {
      ...process.env, GOAL_SETTINGS_DIRECTORY: settingsDirectory, GOAL_CODEX_SERVICE_TIER: 'fast',
    } });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    for (const [index, home] of homes.entries()) {
      if (configs[index] !== undefined) expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(configs[index]);
    }
    return JSON.parse(child.stdout) as Array<{ engine: string; fresh: [string, string[]]; resume: [string, string[]];
      manager: { args: string[]; startArgs: string[]; env: { CODEX_HOME: string; GOAL_SETTINGS_DIRECTORY: string } } | null }>;
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    rmSync(dir, { recursive: true, force: true });
  }
}

const configured = commands([
  '[mcp_servers.playwright]\ncommand = "unused"\n[mcp_servers.outline]\nurl = "https://unused.invalid"\n'
    + '[mcp_servers.node_repl]\ncommand = "unused"\n[mcp_servers.browseros]\nurl = "https://unused.invalid"\n'
    + '[mcp_servers."named.server"]\ncommand = "unused"\nenabled = false\n',
  '[mcp_servers.browseros]\nurl = "https://unused.invalid"\n[mcp_servers.second_account]\ncommand = "unused"\n',
]);

function overrides(args: string[]) {
  return args.flatMap((arg, index) => arg === '-c' && args[index + 1]?.startsWith('mcp_servers=') ? [args[index + 1]] : []);
}

for (const command of configured) {
  const names = command.engine === 'sample-b' ? ['browseros', 'second_account']
    : ['playwright', 'outline', 'node_repl', 'browseros', 'named.server'];
  const expected = [`mcp_servers={${names.map(name => `"${name}"={enabled=false}`).join(',')}}`];
  for (const mode of ['fresh', 'resume'] as const) {
    test(`${command.engine} ${mode} disables every account MCP server without changing its config`, () => {
      const [program, args] = command[mode];
      expect(program).toBe('codex');
      expect(args.slice(0, mode === 'resume' ? 3 : 1)).toEqual(mode === 'resume' ? ['exec', 'resume', 'session'] : ['exec']);
      expect(overrides(args)).toEqual(expected);
      expect(args.slice(-2)).toEqual(['--', '--- brief']);
    });
  }
  if (command.manager) {
    test(`${command.engine} manager fresh and resumed turns disable every account MCP server`, () => {
      expect(overrides(command.manager!.startArgs)).toEqual(expected);
      expect(overrides(command.manager!.args)).toEqual(expected);
      expect(command.manager!.env.CODEX_HOME.endsWith(`/${command.engine}`)).toBe(true);
      expect(command.manager!.env.GOAL_SETTINGS_DIRECTORY.endsWith('/.goalctl')).toBe(true);
    });
  }
}

test('accounts with missing or empty MCP configuration still launch', () => {
  for (const command of commands([undefined, 'model = "gpt-6.1-sol"\n'])) {
    expect(overrides(command.fresh[1])).toEqual([]);
    expect(overrides(command.resume[1])).toEqual([]);
    if (command.manager) {
      expect(overrides(command.manager.startArgs)).toEqual([]);
      expect(overrides(command.manager.args)).toEqual([]);
    }
  }
});
