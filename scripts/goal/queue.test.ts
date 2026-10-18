import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';
import type { QueueLedger } from './queue.ts';
import type { Task } from './types.ts';
import { GoalMailStore } from './mail.ts';
import { testAccountSettings } from './fixtures/accounts.ts';

const spawnSync = fixtureSpawns(60_000);
const fixtures: { directory: string }[] = [];

function repository() {
  const scratch = join(process.cwd(), '.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'brief-queue-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.email', 'queue@example.invalid'); git('config', 'user.name', 'Queue fixture');
  writeFileSync(join(directory, '.gitignore'), '.temp/\n.goalctl/*.user.json\n');
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
    GOAL_CODEX_HOME: join(local, 'codex'), GOAL_TEST_SECOND_HOME: join(local, 'sample-b') };
  Object.assign(env, { GOAL_SETTINGS_DIRECTORY: testAccountSettings(directory, [
    { engine: 'codex', home: env.GOAL_CODEX_HOME }, { engine: 'sample-b', home: env.GOAL_TEST_SECOND_HOME },
  ]) });
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

test('a free brief starts immediately through dispatch and its recording launcher', async () => {
  const f = repository();
  expect(ok(f.run('queue', f.brief()))).toContain('G-002 started');
  const task = f.ledger().tasks['G-002']!;
  expect(task.state).toBe('running');
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
  const record = join(task.worktree, '.temp/record.json');
  for (let n = 0; !existsSync(record) && n < 100; n++) await Bun.sleep(10);
  expect(JSON.parse(readFileSync(record, 'utf8')).prompt).toContain('Deliver the held work.');
});

test('an open dependency waits until the settling pass after verification', () => {
  const f = repository(); const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder(); f.save(ledger);
  expect(ok(f.run('queue', f.brief('G-002', ['depends: [G-001]'])))).toContain('which is stopped');
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeUndefined();
  const verified = f.ledger(); verified.tasks['G-001']!.state = 'verified'; f.save(verified);
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']!.state).toBe('running');
});

test('needed files wait for every result on main and are shown by queue and status', () => {
  const f = repository();
  const path = f.brief('G-002', ['needs: ["replay.ts", \'answer.json\']']);
  writeFileSync(join(f.directory, 'replay.ts'), 'export {};\n');
  writeFileSync(join(f.directory, 'answer.json'), '{}\n');
  const queued = ok(f.run('queue', path));
  for (const file of ['replay.ts', 'answer.json']) {
    expect(queued).toContain(`${file}, which is absent from main`);
    expect(ok(f.run('queue'))).toContain(`${file}, which is absent from main`);
    expect(ok(f.run('status'))).toContain(`${file}, which is absent from main`);
  }
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeUndefined();
  f.git('add', 'replay.ts'); f.git('commit', '-qm', 'Land replay');
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeUndefined();
  expect(f.ledger().queue!['G-002']!.waits).toEqual(['G-002 needs answer.json, which is absent from main']);
  f.git('checkout', '-qb', 'result');
  f.git('add', 'answer.json'); f.git('commit', '-qm', 'Prepare answer off main');
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeUndefined();
  f.git('checkout', 'main'); f.git('merge', '--ff-only', 'result');
  ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']!.state).toBe('running');
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
});

test('dispatch names all needed files absent from main before starting', () => {
  const f = repository();
  const path = f.brief('G-002', ['needs: [replay.ts, answer.json]']);
  writeFileSync(join(f.directory, 'replay.ts'), 'export {};\n');
  const result = f.run('dispatch', path);
  expect(result.status).toBe(1);
  for (const file of ['replay.ts', 'answer.json']) expect(result.stderr).toContain(`${file}, which is absent from main`);
  expect(f.ledger().tasks['G-002']).toBeUndefined();
  expect(existsSync(join(f.local, 'worktrees/g-002'))).toBe(false);
});

test('queue and dispatch refuse invalid needed paths at validation', () => {
  const f = repository();
  for (const file of ['../outside.ts', 'inside/../../outside.ts', '/absolute.ts', 'files/*.ts', 'files/?.ts', 'files/[ab].ts', 'files/{a,b}.ts']) {
    const path = f.brief('G-002', [`needs: ["${file}"]`]);
    for (const command of ['queue', 'dispatch']) {
      const result = f.run(command, path);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid brief');
      expect(result.stderr).toContain('needed path');
    }
    expect(f.ledger().queue?.['G-002']).toBeUndefined();
    expect(f.ledger().tasks['G-002']).toBeUndefined();
  }
});

test('resume does not recheck needed files for an already started task', () => {
  const f = repository();
  const output = join(f.local, 'previous.jsonl');
  mkdirSync(join(f.local, 'goal'), { recursive: true });
  writeFileSync(output, '');
  const ledger = f.ledger();
  const task = f.holder();
  task.brief = f.brief('G-001', ['needs: [missing.ts]']);
  task.needs = ['missing.ts'];
  task.engine = 'codex';
  task.attempts = [{ n: 1, effort: 'high', engine: 'codex', pid: 2147483647, session: 'recording-session',
    output, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }];
  ledger.tasks[task.id] = task; f.save(ledger);
  expect(ok(f.run('resume', task.id, '-m', 'Continue the started work'))).toContain('attempt 2');
  expect(f.ledger().tasks[task.id]!.state).toBe('running');
});

test('a live path claim waits until its holder stops', () => {
  const f = repository(); const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder('running', ['claimed.ts']); f.save(ledger);
  expect(ok(f.run('queue', f.brief()))).toContain('overlaps G-001');
  const closed = f.ledger(); closed.tasks['G-001']!.state = 'stopped'; f.save(closed);
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeDefined();
});

test('an area loan is refused without the flag and retained through a claim wait until dispatch', () => {
  const f = repository();
  const path = f.brief();
  const area = join(f.directory, 'docs/goals/api/GOAL.md');
  mkdirSync(join(f.directory, 'docs/goals/api'), {recursive:true});
  writeFileSync(area, '---\nareas: [claimed.ts]\n---\n');
  const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder('running', ['claimed.ts']); f.save(ledger);
  const refused = f.run('queue', path);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("path claimed.ts lies in Goal api's area");
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
  expect(ok(f.run('queue', path, '--allow-area'))).toContain('overlaps G-001');
  expect(f.ledger().queue!['G-002']!.allowArea).toBe(true);
  ok(f.run('settle'));
  expect(f.ledger().queue!['G-002']!.allowArea).toBe(true);
  const closed = f.ledger(); closed.tasks['G-001']!.state = 'stopped'; f.save(closed);
  ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']!.state).toBe('running');
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
});

test('an area loan survives a dispatch memory refusal and accepts the flag before the brief', () => {
  const f = repository();
  const path = f.brief();
  mkdirSync(join(f.directory, 'docs/goals/api'), {recursive:true});
  writeFileSync(join(f.directory, 'docs/goals/api/GOAL.md'), '---\nareas: [claimed.ts]\n---\n');
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  expect(ok(f.run('queue', '--allow-area', path))).toContain('Memory floor reached');
  expect(f.ledger().queue!['G-002']!.allowArea).toBe(true);
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']!.state).toBe('running');
});

test('an unlanded path overlap dispatches before the branch lands', () => {
  const f = repository();
  f.git('checkout', '-qb', 'goal/holder'); writeFileSync(join(f.directory, 'claimed.ts'), 'export const changed = true;\n');
  f.git('commit', '-qam', 'Change path outside claim'); f.git('checkout', '-q', 'main');
  const ledger = f.ledger(); const task = f.holder(); task.branch = 'goal/holder'; ledger.tasks[task.id] = task; f.save(ledger);
  expect(ok(f.run('queue', f.brief()))).toContain('G-002 started');
  expect(f.ledger().tasks['G-002']!.state).toBe('running');
  expect(f.ledger().tasks['G-001']!.state).toBe('stopped');
});

test('a cancelled dependency stays queued and the listing names cancellation and time', () => {
  const f = repository(); const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder(); f.save(ledger);
  ok(f.run('queue', f.brief('G-002', ['depends: [G-001]'])));
  const cancelled = f.ledger(); cancelled.tasks['G-001']!.state = 'cancelled'; f.save(cancelled);
  ok(f.run('settle'));
  const listing = ok(f.run('queue'));
  expect(listing).toContain('which is cancelled'); expect(listing).toContain(f.ledger().queue!['G-002']!.queuedAt);
  expect(f.ledger().tasks['G-002']).toBeUndefined();
  expect(ok(f.run('queue', '--drop', 'G-002'))).toContain('dropped');
  expect(ok(f.run('queue'))).toBe('No queued briefs\n');
});

test('a memory gate retains the brief and the next pass starts it', () => {
  const f = repository(); writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  expect(ok(f.run('queue', f.brief()))).toContain('Memory floor reached');
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeUndefined();
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  ok(f.run('settle')); expect(f.ledger().tasks['G-002']).toBeDefined();
});

test('a cancelled path holder remains a wait even after its claim is released', () => {
  const f = repository(); const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder('running', ['claimed.ts']); f.save(ledger);
  ok(f.run('queue', f.brief()));
  const cancelled = f.ledger(); cancelled.tasks['G-001']!.state = 'cancelled'; f.save(cancelled);
  ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']).toBeUndefined();
  expect(ok(f.run('queue'))).toContain('waited for G-001, which is cancelled');
});

test('permanent validation and method errors are refused even while a path is held', () => {
  const f = repository(); const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder('running', ['claimed.ts']); f.save(ledger);
  for (const [extra, message] of [[['effort: imaginary'], 'effort must be'], [['kind: implementation'], 'needs at least one row'],
    [['depends: [G-999]'], 'Unknown dependency']] as const) {
    const result = f.run('queue', f.brief('G-002', [...extra]));
    expect(result.status).toBe(1); expect(result.stderr).toContain(message);
    expect(f.ledger().queue?.['G-002']).toBeUndefined();
  }
  const path = f.brief(); writeFileSync(path, readFileSync(path, 'utf8').replace('## Mechanisms', '## Missing'));
  const result = f.run('queue', path); expect(result.status).toBe(1); expect(result.stderr).toContain('## Mechanisms');
});

test('a manager can queue and drop only its own Goal while the program may queue any', () => {
  const f = repository(); f.env.GOAL_ID = 'api';
  expect(f.run('queue', f.brief()).status).toBe(1);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  f.env.GOAL_ID = 'program'; ok(f.run('queue', f.brief()));
  f.env.GOAL_ID = 'api'; expect(f.run('queue', '--drop', 'G-002').status).toBe(1);
  f.env.GOAL_ID = 'program'; ok(f.run('queue', f.brief('G-003', ['paths: [api.ts]'], 'api')));
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  f.env.GOAL_ID = 'api'; ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']!.goal).toBe('program'); expect(f.ledger().tasks['G-003']!.goal).toBe('api');
});

test('a permanent refusal after enqueue leaves the queue and is recorded for its manager', () => {
  const f = repository(); writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n'); const path = f.brief(); ok(f.run('queue', path));
  writeFileSync(path, readFileSync(path, 'utf8').replace('effort: high', 'effort: invalid'));
  ok(f.run('settle'));
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
  expect(f.ledger().queueRefusals!['G-002']!.reason).toContain('effort must be');
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program', 'api'] });
  try { expect(mail.pending('program')[0]!.body).toContain('G-002 queue refused'); }
  finally { mail.close(); }
});

test('ready briefs start oldest first and inactive Goals remain queued', () => {
  const f = repository(); writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  ok(f.run('queue', f.brief('G-003', ['paths: [first.ts]'])));
  ok(f.run('queue', f.brief('G-002', ['paths: [second.ts]'])));
  ok(f.run('queue', f.brief('G-004', ['paths: [api.ts]'], 'api')));
  const ledger = f.ledger(); ledger.goals!.api!.closedAt = new Date().toISOString(); f.save(ledger);
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  const output = ok(f.run('settle'));
  expect(output.indexOf('G-003 started')).toBeLessThan(output.indexOf('G-002 started'));
  expect(f.ledger().queue!['G-004']!.waits).toEqual(['Goal api is not active']);
  expect(ok(f.run('queue'))).toContain('Goal api is not active');
});

test('concurrent settling passes dispatch a queued brief once', async () => {
  const f = repository(); writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n'); ok(f.run('queue', f.brief()));
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  const run = async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goalctl.ts'), 'settle'],
      { cwd: f.directory, env: f.env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  const outputs = await Promise.all([run(), run()]);
  expect(outputs.join('').match(/G-002 started/g)).toHaveLength(1);
  expect(f.ledger().tasks['G-002']!.attempts).toHaveLength(1);
  expect(f.ledger().queue?.['G-002']).toBeUndefined();
});

test('a restarted pass recovers a dead launch owner and an already published task', () => {
  const f = repository(); writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n'); ok(f.run('queue', f.brief()));
  const ledger = f.ledger(); const entry = ledger.queue!['G-002']!; entry.owner = { pid: 2147483647 }; f.save(ledger);
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n'); ok(f.run('settle'));
  expect(f.ledger().tasks['G-002']).toBeDefined();
  const published = f.ledger(); published.queue = { 'G-002': entry }; f.save(published);
  ok(f.run('settle'));
  expect(f.ledger().queue?.['G-002']).toBeUndefined(); expect(f.ledger().queueRefusals?.['G-002']).toBeUndefined();
});

function recordingGit(f: ReturnType<typeof repository>) {
  const log = join(f.local, 'git-calls.jsonl');
  const executable = Bun.which('git')!;
  writeFileSync(join(f.local, 'bin/git'), `#!${process.execPath}
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    if (!args.includes('--git-common-dir')) appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    const result = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `);
  chmodSync(join(f.local, 'bin/git'), 0o755);
  writeFileSync(log, '');
  return { clear: () => writeFileSync(log, ''), calls: (): string[][] =>
    readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) };
}

function pump(f: ReturnType<typeof repository>) {
  return spawnSync(process.execPath, ['-e', `import { pumpQueue } from ${JSON.stringify(join(import.meta.dir, 'queue.ts'))}; await pumpQueue();`],
    { cwd: f.directory, encoding: 'utf8', env: f.env });
}

async function endedWorker(f: ReturnType<typeof repository>) {
  ok(f.run('dispatch', f.brief()));
  const task = f.ledger().tasks['G-002']!;
  const record = join(task.worktree, '.temp/record.json');
  for (let n = 0; !existsSync(record) && n < 100; n++) await Bun.sleep(10);
  expect(existsSync(record)).toBe(true);
  const ledger = f.ledger();
  const current = ledger.tasks[task.id]!;
  current.state = 'exited';
  current.attempts[0]!.pid = 0;
  current.attempts[0]!.session = 'recording-session';
  current.attempts[0]!.endedAt = new Date().toISOString();
  f.save(ledger);
  rmSync(record);
  return current;
}

test.each(['memory', 'cap', 'account'])('a resume waits for %s admission and preserves its message and options', async gate => {
  const f = repository(); const task = await endedWorker(f);
  const usageDirectory = join(f.env.GOAL_TEST_SECOND_HOME, 'sessions/2026/10/13');
  const usage = join(usageDirectory, 'usage.jsonl');
  if (gate === 'memory') writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  if (gate === 'cap') f.env.GOAL_MAX_WORKERS = '0';
  if (gate === 'account') {
    mkdirSync(usageDirectory, { recursive: true });
    writeFileSync(usage, JSON.stringify({ timestamp: new Date().toISOString(), payload: { rate_limits: {
      primary: { used_percent: 100, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
    } } }));
  }
  const note = join(f.local, 'resume-note'); writeFileSync(note, 'Continue with the retained note.');
  const output = ok(f.run('resume', task.id, '--file', note, '--engine', 'sample-b', '--effort', 'medium', '--fresh'));
  expect(output).toContain('resume waiting:');
  expect(f.ledger().tasks[task.id]!.waitingResume).toMatchObject({ message: 'Continue with the retained note.',
    engine: 'sample-b', effort: 'medium', fresh: true, forceUsage: false });
  expect(f.ledger().tasks[task.id]!.attempts).toHaveLength(1);
  rmSync(note);
  const status = ok(f.run('status'));
  expect(status).toContain('G-002 waiting'); expect(status).toContain('waiting 1;');
  expect(status).toContain(f.ledger().tasks[task.id]!.waitingResume!.reason);
  expect(pump(f).status).toBe(0); expect(f.ledger().tasks[task.id]!.attempts).toHaveLength(1);
  ok(f.run('settle')); expect(f.ledger().tasks[task.id]!.settlement).toBeUndefined();
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n'); f.env.GOAL_MAX_WORKERS = '25';
  if (gate === 'account') rmSync(usage);
  expect(pump(f).status).toBe(0);
  const resumed = f.ledger().tasks[task.id]!;
  expect(resumed.waitingResume).toBeUndefined(); expect(resumed.attempts).toHaveLength(2);
  expect(resumed.attempts[1]!.effort).toBe('medium');
  const record = join(task.worktree, '.temp/record.json');
  for (let n = 0; !existsSync(record) && n < 100; n++) await Bun.sleep(10);
  const observed = JSON.parse(readFileSync(record, 'utf8')) as { prompt: string; args: string[] };
  expect(observed.prompt).toContain('Continue with the retained note.'); expect(observed.args).not.toContain('resume');
});

test('a second resume replaces the waiting message and starts before a queued brief', async () => {
  const f = repository(); const task = await endedWorker(f);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  ok(f.run('resume', task.id, '-m', 'Old note.', '--fresh'));
  const previous = f.ledger().tasks[task.id]!.waitingResume!.token;
  ok(f.run('queue', f.brief('G-003', ['paths: [new.ts]'])));
  ok(f.run('resume', task.id, '-m', 'Replacement note.', '--effort', 'low'));
  expect(f.ledger().tasks[task.id]!.waitingResume!.token).not.toBe(previous);
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  const output = pump(f); expect(output.status, output.stderr).toBe(0);
  expect(output.stdout.indexOf('G-002 attempt 2')).toBeLessThan(output.stdout.indexOf('G-003 started'));
  const record = join(task.worktree, '.temp/record.json');
  for (let n = 0; !existsSync(record) && n < 100; n++) await Bun.sleep(10);
  const observed = JSON.parse(readFileSync(record, 'utf8')) as { prompt: string; args: string[] };
  expect(observed.prompt).toContain('Replacement note.'); expect(observed.prompt).not.toContain('Old note.');
  expect(observed.args).toContain('resume'); expect(f.ledger().tasks[task.id]!.attempts[1]!.effort).toBe('low');
});

test.each(['stop', 'close'])('%s removes a waiting resume', async action => {
  const f = repository(); const task = await endedWorker(f);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n'); ok(f.run('resume', task.id, '-m', 'Continue.'));
  ok(f.run(action, task.id, ...action === 'close' ? ['cancelled'] : []));
  expect(f.ledger().tasks[task.id]!.waitingResume).toBeUndefined();
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n'); expect(pump(f).status).toBe(0);
  expect(f.ledger().tasks[task.id]!.attempts).toHaveLength(1);
});

test('other resume refusals fail without being kept', async () => {
  const f = repository(); const task = await endedWorker(f);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  const result = f.run('resume', task.id, '-m', 'Continue.', '--effort', 'imaginary');
  expect(result.status).toBe(1); expect(result.stderr).toContain('effort must be');
  expect(f.ledger().tasks[task.id]!.waitingResume).toBeUndefined();
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  writeFileSync(f.env.GOAL_USAGE_FILE, JSON.stringify({ at: Date.now() / 1000, rate_limits: {
    five_hour: { used_percentage: 100, resets_at: Date.now() / 1000 + 3600 },
  } }));
  const usage = f.run('resume', task.id, '-m', 'Continue.', '--engine', 'claude', '--effort', 'high');
  expect(usage.status).toBe(0); expect(usage.stdout).toContain('Claude usage is restricted');
  expect(f.ledger().tasks[task.id]!.waitingResume!.reason).toContain('policy disabled or independent review missing');
});

test('concurrent passes start a waiting resume once', async () => {
  const f = repository(); const task = await endedWorker(f);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  ok(f.run('resume', task.id, '-m', 'Continue once.', '--force-usage'));
  expect(f.ledger().tasks[task.id]!.waitingResume!.forceUsage).toBe(true);
  writeFileSync(f.meminfo, 'MemAvailable: 67108864 kB\n');
  const run = async () => {
    const child = Bun.spawn([process.execPath, '-e', `import { pumpQueue } from ${JSON.stringify(join(import.meta.dir, 'queue.ts'))}; await pumpQueue();`],
      { cwd: f.directory, env: f.env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0); expect(stderr).toBe(''); return stdout;
  };
  const outputs = await Promise.all([run(), run()]);
  expect(outputs.join('').match(/G-002 attempt 2/g)).toHaveLength(1);
  expect(f.ledger().tasks[task.id]!.attempts).toHaveLength(2);
  expect(f.ledger().tasks[task.id]!.waitingResume).toBeUndefined();
});

test('a pass waiting on running dependencies performs no git work or outcome loads', () => {
  const f = repository(); const git = recordingGit(f);
  const loads = join(f.local, 'outcome-loads');
  const outcomeDir = join(f.directory, 'scripts/qa/cases'); mkdirSync(outcomeDir, { recursive: true });
  writeFileSync(join(outcomeDir, 'outcomes.ts'), `import { appendFileSync } from 'node:fs';
    export const personas = ['reader'];
    export async function loadOutcomes() {
      appendFileSync(${JSON.stringify(loads)}, 'load\\n');
      return new Map([['program/lock', { cells: { reader: { state: 'pending' } } }]]);
    }
  `);
  const ledger = f.ledger(); ledger.tasks['G-001'] = f.holder('running'); f.save(ledger);
  const paths: string[] = [];
  for (const id of ['G-002', 'G-003', 'G-004']) {
    const path = f.brief(id, ['kind: implementation', 'rows: [program/lock]', 'depends: [G-001]', `paths: [${id.toLowerCase()}.ts]`]);
    paths.push(path); expect(ok(f.run('queue', path))).toContain('which is running');
  }
  // Edited validation is deferred until the dependency would permit dispatch.
  writeFileSync(paths[0]!, readFileSync(paths[0]!, 'utf8').replace('effort: high', 'effort: invalid'));
  git.clear(); writeFileSync(loads, '');
  expect(pump(f).status).toBe(0);
  expect(git.calls()).toEqual([]); expect(readFileSync(loads, 'utf8')).toBe('');
  expect(Object.keys(f.ledger().queue!)).toHaveLength(3);
  const ready = f.ledger(); ready.tasks['G-001']!.state = 'verified'; f.save(ready);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  const result = pump(f); expect(result.status, result.stderr).toBe(0);
  expect(f.ledger().queueRefusals!['G-002']!.reason).toContain('effort must be');
});

test('a pass never scans unlanded branches to admit otherwise ready entries', () => {
  const f = repository();
  f.git('checkout', '-qb', 'goal/holder'); writeFileSync(join(f.directory, 'claimed.ts'), 'export const changed = true;\n');
  f.git('commit', '-qam', 'Change path outside claim'); f.git('checkout', '-q', 'main');
  const ledger = f.ledger(); const holder = f.holder(); holder.branch = 'goal/holder'; ledger.tasks[holder.id] = holder; f.save(ledger);
  writeFileSync(f.meminfo, 'MemAvailable: 1024 kB\n');
  for (const id of ['G-002', 'G-003', 'G-004']) expect(ok(f.run('queue', f.brief(id)))).toContain('Memory floor reached');
  const git = recordingGit(f); const result = pump(f); expect(result.status, result.stderr).toBe(0);
  const scans = git.calls().filter(args => args[0] === 'diff');
  expect(scans).toEqual([]); expect(Object.keys(f.ledger().queue!)).toHaveLength(3);
});
