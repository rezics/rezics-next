import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function commands(configs: [string | undefined, string | undefined]) {
  const parent = join(import.meta.dir, '../../.temp/launch');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'c-'));
  const homes = [join(dir, 'codex'), join(dir, 'codex-1')];
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
      console.log(JSON.stringify(['codex', 'codex-1', 'luna'].map(engine => {
        const worker = resume => launchCommand({ id: 'worker', engine, effort: 'high', session: 'session',
          prompt: '--- brief', resume, worktree: ${JSON.stringify(dir)} });
        const manager = engine === 'luna' ? null : coordinatorStartDescriptor(
          coordinatorStartOptions(['program', '--engine', engine, '--effort', 'high']),
          ${JSON.stringify(dir)}, ${JSON.stringify(socket)});
        return { engine, fresh: worker(false), resume: worker(true), manager };
      })));
    `], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: {
      ...process.env, GOAL_CODEX_HOME: homes[0], GOAL_CODEX_1_HOME: homes[1], GOAL_CODEX_SERVICE_TIER: 'fast',
    } });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    for (const [index, home] of homes.entries()) {
      if (configs[index] !== undefined) expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(configs[index]);
    }
    return JSON.parse(child.stdout) as Array<{ engine: string; fresh: [string, string[]]; resume: [string, string[]];
      manager: { args: string[]; startArgs: string[]; env: { CODEX_HOME: string } } | null }>;
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
  const names = command.engine === 'codex-1' ? ['browseros', 'second_account']
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
