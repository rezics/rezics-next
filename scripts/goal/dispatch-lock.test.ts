import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';
import type { QueueLedger } from './queue.ts';
import type { Task } from './types.ts';

const spawnSync = fixtureSpawns(60_000);
const fixtures: { directory: string }[] = [];

function repository() {
  const scratch = join(process.cwd(), '.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'dispatch-lock-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.email', 'queue@example.invalid'); git('config', 'user.name', 'Queue fixture');
  writeFileSync(join(directory, '.gitignore'), '.temp/\n');
  writeFileSync(join(directory, 'claimed.ts'), 'export {};\n');
  git('add', '.'); git('commit', '-qm', 'Fixture');
  const local = join(directory, '.temp');
  const state = join(local, 'goal-orchestration');
  const bin = join(local, 'bin');
  mkdirSync(bin, { recursive: true }); mkdirSync(state, { recursive: true });
  // The handover fixture's recording launcher: no model calls, only native argv and tree evidence.
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    writeFileSync(args[args.indexOf('-o') + 1], 'RESULT: partial\\nNEXT: fixture step\\n');
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'recording-session' }));
    writeFileSync('.temp/record.json', JSON.stringify({ args, prompt: args.at(-1) }));\n`);
  writeFileSync(join(bin, 'corepack'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'codex'), 0o755); chmodSync(join(bin, 'corepack'), 0o755);
  const meminfo = join(local, 'meminfo');
  writeFileSync(meminfo, 'MemAvailable: 67108864 kB\n');
  const env = { ...process.env, GOAL_ID: 'program', PATH: `${bin}:${process.env.PATH}`, GOAL_MEMORY_FLOOR_GIB: '12',
    GOAL_MAX_WORKERS: '25', GOAL_MEMINFO_FILE: meminfo, GOAL_USAGE_FILE: join(local, 'usage.json'),
    GOAL_CODEX_HOME: join(local, 'codex') };
  const ledgerPath = join(state, 'ledger.json');
  const save = (ledger: QueueLedger) => writeFileSync(ledgerPath, JSON.stringify(ledger));
  const ledger = (): QueueLedger => JSON.parse(readFileSync(ledgerPath, 'utf8')) as QueueLedger;
  save({ tasks: {}, goals: { program: { manager: 'recording-manager', startedAt: new Date().toISOString() },
    api: { manager: 'api-manager', startedAt: new Date().toISOString() } } });
  const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), ...args],
    { cwd: directory, encoding: 'utf8', env });
  const brief = (id = 'G-002', extra: string[] = [], goal = 'program') => {
    const folder = join(directory, 'docs/goals', goal, 'tasks');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${id}.md`);
    writeFileSync(path, ['---', `id: ${id}`, 'title: Held work', 'kind: tooling', 'engine: sol', 'effort: high',
      'paths: [claimed.ts]', ...extra, '---', '', '## Outcome', '', 'Deliver the held work.', '', '## Mechanisms', '', 'none', ''].join('\n'));
    return path;
  };
  const holder = (state: Task['state'] = 'stopped', paths = ['other.ts']): Task => ({
    id: 'G-001', title: 'Holder', effort: 'high', kind: 'tooling', cases: [], paths, shared: [], depends: [], migrations: [],
    worktree: directory, branch: 'main', base: git('rev-parse', 'HEAD'), brief: '', goal: 'program', state, attempts: [],
  });
  const current = { directory, local, state, meminfo, env, git, run, brief, holder, ledger, save };
  fixtures.push(current);
  return current;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.directory, { recursive: true, force: true });
});

function ok(result: ReturnType<ReturnType<typeof repository>['run']>): string {
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

test.each([[], ['--dry-run'], ['--engine', 'sol', '--dry-run']])(
  'dispatch without a brief or ID reports usage (%j)', (...args) => {
    const f = repository();
    const result = f.run('dispatch', ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: goalctl dispatch <G-id|brief.md>');
    expect(result.stderr).not.toMatch(/EISDIR|ENOENT/);
    expect(f.ledger().tasks).toEqual({});
  },
);

test.each([['G-002', '--dry-run'], ['--engine', 'sol', 'G-002', '--dry-run']])(
  'dispatch resolves an ID in the calling Goal (%j)', (...args) => {
    const f = repository();
    f.brief();
    // Another active Goal must not make the caller's task ID ambiguous.
    f.brief('G-002', ['kind: invalid'], 'api');
    expect(ok(f.run('dispatch', ...args))).toContain('G-002: claims ok');
    expect(f.ledger().tasks).toEqual({});
  },
);

test('dispatch resolves an ID when only one Goal is active', () => {
  const f = repository();
  f.brief();
  Reflect.deleteProperty(f.env, 'GOAL_ID');
  f.save({ tasks: {}, goals: { program: f.ledger().goals!.program! } });
  expect(ok(f.run('dispatch', 'G-002', '--dry-run'))).toContain('G-002: claims ok');
});

test('dispatch refuses an ID without a caller when several Goals are active', () => {
  const f = repository();
  f.brief();
  Reflect.deleteProperty(f.env, 'GOAL_ID');
  const result = f.run('dispatch', 'G-002', '--dry-run');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Several Goals are active');
  expect(f.ledger().tasks).toEqual({});
});

async function preparing(f: ReturnType<typeof repository>, fail = false) {
  const marker = join(f.local, 'install-started');
  const release = join(f.local, 'install-release');
  writeFileSync(join(f.local, 'bin/corepack'), `#!${process.execPath}
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'started');
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
    process.exit(${fail ? 1 : 0});
  `);
  const brief = f.brief();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goalctl.ts'), 'dispatch', brief],
    { cwd: f.directory, env: f.env, stdout: 'pipe', stderr: 'pipe' });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  for (let n = 0; !existsSync(marker) && n < 500; n++) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
  return { brief, result, release: () => writeFileSync(release, 'release') };
}

async function whilePreparing(f: ReturnType<typeof repository>, args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goalctl.ts'), ...args],
    { cwd: f.directory, env: f.env, stdout: 'pipe', stderr: 'pipe' });
  const completed = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([completed, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { child.kill(); reject(new Error('ledger command waited for installation')); }, 5000);
    })]);
  } finally { clearTimeout(deadline); }
}

test('another ledger command completes while dispatch installs, and status shows preparation', async () => {
  const f = repository(); const pending = await preparing(f);
  try {
    const [code, output, error] = await whilePreparing(f, ['new', '--goal', 'program', '--kind', 'tooling', 'Concurrent work']);
    expect(code, error).toBe(0); expect(output).toContain('reserved for Goal program');
    const [status, text, stderr] = await whilePreparing(f, ['status']);
    expect(status, stderr).toBe(0); expect(text).toContain('G-002 starting'); expect(text).toContain('preparing worktree'); expect(text).toContain('live 1/25');
    expect(f.ledger().tasks['G-002']!.attempts).toEqual([]);
  } finally { pending.release(); await pending.result; }
});

test('preparing claims refuse a conflict and a second dispatch of the same brief', async () => {
  const f = repository(); const pending = await preparing(f);
  try {
    const [code, , error] = await whilePreparing(f, ['dispatch', f.brief('G-003')]);
    expect(code).toBe(1); expect(error).toContain('Claim conflict'); expect(error).toContain('G-002');
    const [same, , reason] = await whilePreparing(f, ['dispatch', pending.brief]);
    expect(same).toBe(1); expect(reason).toContain('already exists (starting)');
    for (const command of ['merge', 'gate', 'resume', 'stop', 'close']) {
      const [code, , error] = await whilePreparing(f, [command, 'G-002', ...command === 'close' ? ['cancelled'] : command === 'resume' ? ['-m', 'Continue'] : []]);
      expect(code).toBe(1); expect(error).toContain('is being prepared');
    }
    expect(f.ledger().tasks['G-002']!.state).toBe('starting');
  } finally { pending.release(); await pending.result; }
});

test('a failed install releases its task and claims, and dispatch can retry', async () => {
  const f = repository(); const pending = await preparing(f, true);
  pending.release(); const [code, , error] = await pending.result;
  expect(code).toBe(1); expect(error).toContain('runs/G-002/install.log');
  expect(f.ledger().tasks['G-002']).toBeUndefined();
  writeFileSync(join(f.local, 'bin/corepack'), '#!/bin/sh\nexit 0\n');
  expect(ok(f.run('dispatch', pending.brief))).toContain('G-002 started');
});

test('preparation consumes the worker width before the first attempt', async () => {
  const f = repository(); f.env.GOAL_MAX_WORKERS = '1'; const pending = await preparing(f);
  try {
    const [code, , error] = await whilePreparing(f, ['dispatch', f.brief('G-003', ['paths: [other.ts]'])]);
    expect(code).toBe(1); expect(error).toContain('Concurrency limit reached: 1/1');
  } finally { pending.release(); await pending.result; }
});
