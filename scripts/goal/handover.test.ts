import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBrief, validateBrief } from './briefs.ts';
import { prepareHandover, solAccount, strayFiles } from './handover.ts';
import { launchCommand } from './launch.ts';
import { parseCodexUsage } from './usage.ts';
import type { AccountUsage, Ledger, Task } from './types.ts';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';

const spawnSync = fixtureSpawns(60_000);
const cli = join(import.meta.dir, 'goalctl.ts');
// Tiny fixture repositories need short physical paths to exercise the real PostgreSQL socket guard.
const scratch = join(tmpdir(), '.temp');

export function repository() {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'worker-handover-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'goal@example.invalid');
  git('config', 'user.name', 'worker handover test');
  writeFileSync(join(dir, '.gitignore'), '.temp/\n');
  writeFileSync(join(dir, 'claimed.ts'), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const local = join(dir, '.temp');
  const bin = join(local, 'bin');
  mkdirSync(bin, { recursive: true });
  // This launcher observes the tree at process start; it records no model or network activity.
  const launcher = join(bin, 'codex');
  writeFileSync(launcher, `#!${process.execPath}
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const refs = Object.fromEntries((existsSync('.temp/ref') ? readdirSync('.temp/ref') : [])
  .map(name => [name, readFileSync(join('.temp/ref', name), 'utf8')]));
const record = { args, refs, prompt: args.at(-1), account: process.env.CODEX_HOME,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
const last = args[args.indexOf('-o') + 1];
writeFileSync(last, 'RESULT: partial\\nNEXT: fixture step\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'recording-session' }) + '\\n');
writeFileSync('.temp/record.json', JSON.stringify(record));
`);
  chmodSync(launcher, 0o755);
  const installer = join(bin, 'corepack');
  writeFileSync(installer, '#!/bin/sh\nexit 0\n');
  chmodSync(installer, 0o755);
  mkdirSync(join(local, 'goal-orchestration'), { recursive: true });
  const ledgerPath = join(local, 'goal-orchestration/ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({ manager: 'recording-manager', tasks: {} }));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, GOAL_MAX_WORKERS: '25', GOAL_MEMORY_FLOOR_GIB: '0',
    GOAL_USAGE_FILE: join(local, 'usage.json'),
    GOAL_CODEX_HOME: join(local, 'codex'), GOAL_CODEX_1_HOME: join(local, 'codex-1'),
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env });
  const ledger = (): Ledger => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  const save = (value: Ledger) => writeFileSync(ledgerPath, JSON.stringify(value));
  const brief = (extra: string[] = []) => {
    const file = join(local, 'brief.md');
    writeFileSync(file, ['---', 'id: G-001', 'kind: tooling', 'title: Worker handover', 'engine: sol', 'effort: high',
      'paths: [claimed.ts, new*.ts]', 'tests: [proof.test.ts]', ...extra, '---', '', '## Outcome', '',
      'Read the staged evidence before implementing.', '', '## Mechanisms', '', 'none', ''].join('\n'));
    return file;
  };
  const reference = (name: string, bytes = `private evidence ${name}`) => {
    const file = join(local, name);
    writeFileSync(file, bytes);
    return file;
  };
  const record = async (task: Task) => {
    const file = join(task.worktree, '.temp/record.json');
    const deadline = Date.now() + 10_000;
    while (!existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`Recording launcher did not start: ${readFileSync(task.attempts.at(-1)!.output.replace('.json', '.err'), 'utf8')}`);
      await Bun.sleep(10);
    }
    return JSON.parse(readFileSync(file, 'utf8')) as { args: string[]; refs: Record<string, string>; prompt: string; account: string; head: string };
  };
  return { dir, local, run, git, ledger, save, brief, reference, record,
    dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function weeklyUsage(home: string, week: number, fiveHour = 5): void {
  const sessions = join(home, 'sessions/2026/10/13');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'usage.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), payload: { rate_limits: {
    primary: { used_percent: fiveHour, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
    secondary: { used_percent: week, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 },
  } } }));
}

describe('worker handover', () => {
  test.each(['verified', 'cancelled'] as const)('dispatch and resume read %s task references from retained artifacts', async outcome => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.goals = { program: { manager: 'recording-manager', startedAt: new Date().toISOString() } };
      repo.save(ledger);
      const source = join(repo.dir, 'docs/goals/program/tasks/G-001.md');
      mkdirSync(join(source, '..'), { recursive: true });
      const text = readFileSync(repo.brief(), 'utf8');
      writeFileSync(source, text);
      expect(repo.run('dispatch', source).status).toBe(0);
      const first = repo.ledger().tasks['G-001']!;
      await repo.record(first);
      const evidence = join(first.worktree, '.temp/goal/evidence.txt');
      writeFileSync(evidence, 'retained evidence');
      const closing = repo.ledger();
      closing.tasks['G-001']!.state = outcome === 'verified' ? 'merged' : 'exited';
      closing.tasks['G-001']!.attempts[0]!.pid = 0;
      repo.save(closing);
      const closed = repo.run('close', 'G-001', outcome);
      expect(closed.status, closed.stderr).toBe(0);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(first.worktree)).toBe(false);
      const file = repo.brief([`refs: [${source}]`]);
      writeFileSync(file, readFileSync(file, 'utf8').replace('id: G-001', 'id: G-002'));
      const dispatched = repo.run('dispatch', file);
      expect(dispatched.status, dispatched.stderr).toBe(0);
      const next = repo.ledger().tasks['G-002']!;
      expect((await repo.record(next)).refs).toEqual({ 'G-001.md': text });
      const current = repo.ledger();
      current.tasks['G-002']!.state = 'exited';
      current.tasks['G-002']!.attempts[0]!.pid = 0;
      repo.save(current);
      writeFileSync(file, readFileSync(file, 'utf8').replace(`refs: [${source}]`, `refs: [${source}, ${evidence}]`));
      expect(repo.run('reclaim', 'G-002', file).status).toBe(0);
      rmSync(join(next.worktree, '.temp/record.json'));
      const resumed = repo.run('resume', 'G-002', '-m', 'Use the retained evidence.');
      expect(resumed.status, resumed.stderr).toBe(0);
      expect((await repo.record(repo.ledger().tasks['G-002']!)).refs).toEqual({ 'G-001.md': text, 'evidence.txt': 'retained evidence' });
    } finally { repo.dispose(); }
  });

  test.each(['open task', 'unknown task', 'wrong Goal', 'unrelated path', 'missing artifact'])('a missing reference to %s still refuses', async kind => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.tasks['G-009'] = { id: 'G-009', title: 'Reference owner', effort: 'high', cases: [], paths: [],
        shared: [], depends: [], migrations: [], worktree: join(repo.local, 'worktrees/g-009'), branch: 'goal/g-009',
        base: repo.git('rev-parse', 'HEAD'), brief: '', state: kind === 'open task' ? 'stopped' : 'verified', goal: 'program', attempts: [] };
      repo.save(ledger);
      const retained = join(repo.local, 'goal-orchestration/runs/G-009/worktree-temp/goal');
      mkdirSync(retained, { recursive: true });
      if (kind !== 'missing artifact') writeFileSync(join(retained, 'brief.md'), 'kept copy');
      const ref = kind === 'unknown task' ? 'docs/goals/program/tasks/G-008.md'
        : kind === 'wrong Goal' ? 'docs/goals/api/tasks/G-009.md'
          : kind === 'unrelated path' ? '.temp/brief.md' : 'docs/goals/program/tasks/G-009.md';
      const brief = parseBrief(readFileSync(repo.brief(), 'utf8'));
      brief.refs = [ref];
      // Remove the ordinary brief for the unrelated-path check; the retained copy must not hide it.
      if (kind === 'unrelated path') rmSync(join(repo.local, 'brief.md'));
      await expect(prepareHandover(brief, 'brief text', repo.dir)).rejects.toThrow('Reference does not exist');
    } finally { repo.dispose(); }
  });

  test('stopping and extending a brief uses steps without exhausting fix rounds', async () => {
    const repo = repository();
    try {
      const file = repo.brief();
      expect(repo.run('dispatch', file).status).toBe(0);
      for (let n = 0; n < 3; n++) {
        const task = repo.ledger().tasks['G-001']!;
        await repo.record(task);
        rmSync(task.attempts.at(-1)!.lastMessage!);
        const ledger = repo.ledger();
        ledger.tasks['G-001']!.attempts.at(-1)!.pid = 0;
        repo.save(ledger);
        expect(repo.run('stop', 'G-001').status).toBe(0);
        writeFileSync(file, readFileSync(file, 'utf8').replace('## Mechanisms', `Extended step ${n + 1}.\n\n## Mechanisms`));
        const reclaimed = repo.run('reclaim', 'G-001', file);
        expect(reclaimed.status, reclaimed.stderr).toBe(0);
        rmSync(join(task.worktree, '.temp/record.json'));
        const result = repo.run('resume', 'G-001', '-m', 'Continue with the extended brief.');
        expect(result.status, result.stderr).toBe(0);
        expect(repo.ledger().tasks['G-001']!.attempts.at(-1)!.round).toBe('step');
      }
      await repo.record(repo.ledger().tasks['G-001']!);
      expect(repo.ledger().tasks['G-001']!.attempts.map(attempt => attempt.round)).toEqual(['initial', 'step', 'step', 'step']);
    } finally { repo.dispose(); }
  });

  test.each(['conflict', 'stopped'] as const)('a refused landing with a handoff still uses a fix round (%s)', async state => {
    const repo = repository();
    try {
      expect(repo.run('dispatch', repo.brief()).status).toBe(0);
      const task = repo.ledger().tasks['G-001']!;
      await repo.record(task);
      const ledger = repo.ledger();
      const current = ledger.tasks['G-001']!;
      current.state = state;
      current.refusal = 'Review found a blocking defect';
      current.attempts[0]!.pid = 0;
      current.attempts[0]!.endedAt = new Date().toISOString();
      writeFileSync(current.attempts[0]!.lastMessage!, 'RESULT: done\nNEXT: land\n');
      repo.save(ledger);
      rmSync(join(task.worktree, '.temp/record.json'));
      const result = repo.run('resume', 'G-001', '-m', 'Fix the review finding.');
      expect(result.status, result.stderr).toBe(0);
      const resumed = repo.ledger().tasks['G-001']!;
      await repo.record(resumed);
      expect(resumed.attempts.at(-1)!.round).toBe('fix');
    } finally { repo.dispose(); }
  });

  test('dispatch stages references and carries the brief, test files and indexed operations before launch', async () => {
    const repo = repository();
    try {
      const evidence = repo.reference('evidence.txt');
      const routeDir = join(repo.dir, 'services/main/src/routes');
      mkdirSync(routeDir, { recursive: true });
      writeFileSync(join(routeDir, 'widgets.ts'), `export const openApiOperations = {
        '/widgets': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } }
      };
      const app = { get() {} };
      app.get('/widgets', () => null);
      `);
      mkdirSync(join(repo.dir, 'tests/unit'), { recursive: true });
      writeFileSync(join(repo.dir, 'tests/unit/widgets.test.ts'), "fetch('/widgets');\n");
      repo.git('add', 'services', 'tests');
      repo.git('commit', '-qm', 'API fixture');
      const file = repo.brief([`refs: [${evidence}]`, 'operations: [getWidgets]']);
      const result = repo.run('dispatch', file);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const task = repo.ledger().tasks['G-001']!;
      const recorded = await repo.record(task);
      expect(recorded.refs).toEqual({ 'evidence.txt': 'private evidence evidence.txt' });
      expect(recorded.prompt).toContain(readFileSync(file, 'utf8'));
      expect(recorded.prompt).toContain('Staged references: .temp/ref/evidence.txt');
      expect(recorded.prompt).toContain('Tests: proof.test.ts');
      expect(recorded.prompt).toContain('Read docs/goals/worker.md');
      expect(recorded.prompt).toContain('operationId: getWidgets\nGET /widgets\nexposure: public\nrate-limit family: read\nbearer: required\nidempotency key: no');
      expect(recorded.prompt).toContain('handler: services/main/src/routes/widgets.ts:');
      expect(recorded.prompt).toContain('widgets.test.ts');
      expect(recorded.prompt).not.toContain('private evidence evidence.txt');
      expect(task.engine).toBe('codex');
    } finally { repo.dispose(); }
  });

  test('resume stages references added by reclaim and stays on the original Sol account', async () => {
    const repo = repository();
    try {
      weeklyUsage(join(repo.local, 'codex'), 70, 1);
      weeklyUsage(join(repo.local, 'codex-1'), 20, 80);
      const first = repo.reference('first.txt');
      const dispatched = repo.run('dispatch', repo.brief([`refs: [${first}]`]));
      expect(dispatched.stderr).toBe('');
      expect(dispatched.status).toBe(0);
      const initial = repo.ledger().tasks['G-001']!;
      const recorded = await repo.record(initial);
      expect(initial.engine).toBe('codex-1');
      expect(recorded.account).toBe(join(repo.local, 'codex-1'));
      const ledger = repo.ledger();
      ledger.tasks['G-001']!.state = 'exited';
      ledger.tasks['G-001']!.attempts[0]!.pid = 0;
      ledger.tasks['G-001']!.attempts[0]!.session = 'recording-session';
      repo.save(ledger);
      const second = repo.reference('second.txt');
      const file = repo.brief([`refs: [${first}, ${second}]`]);
      expect(repo.run('reclaim', 'G-001', file).status).toBe(0);
      weeklyUsage(join(repo.local, 'codex'), 5);
      weeklyUsage(join(repo.local, 'codex-1'), 85);
      rmSync(join(initial.worktree, '.temp/record.json'));
      const resumed = repo.run('resume', 'G-001', '--engine', 'sol', '-m', 'Use the added evidence.');
      expect(resumed.stderr).toBe('');
      expect(resumed.status).toBe(0);
      const current = repo.ledger().tasks['G-001']!;
      const next = await repo.record(current);
      expect(current.engine).toBe('codex-1');
      expect(next.account).toBe(join(repo.local, 'codex-1'));
      expect(next.args.slice(0, 3)).toEqual(['exec', 'resume', 'recording-session']);
      expect(next.refs).toEqual({ 'first.txt': 'private evidence first.txt', 'second.txt': 'private evidence second.txt' });
      expect(next.prompt).toContain(readFileSync(file, 'utf8'));
      expect(next.prompt).toContain('.temp/ref/second.txt');
    } finally { repo.dispose(); }
  });

  test.each(['missing', 'duplicate'])('refuses a %s reference before creating a worktree or branch', kind => {
    const repo = repository();
    try {
      const first = repo.reference('same.txt');
      const refs = kind === 'missing' ? [join(repo.local, 'absent.txt')] : [first, first];
      const result = repo.run('dispatch', repo.brief([`refs: [${refs.join(', ')}]`]));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(kind === 'missing' ? 'Reference does not exist' : 'same file name');
      expect(existsSync(join(repo.dir, '.temp/worktrees/g-001'))).toBe(false);
      expect(repo.git('branch', '--list', 'goal/g-001')).toBe('');
      expect(repo.ledger().tasks).toEqual({});
    } finally { repo.dispose(); }
  });

  test('all operation context is bounded to sixty lines and includes every query', async () => {
    const repo = repository();
    try {
      const routes = join(repo.dir, 'services/main/src/routes');
      mkdirSync(routes, { recursive: true });
      const paths = Array.from({ length: 15 }, (_, index) => `/widgets/${index}`);
      writeFileSync(join(routes, 'widgets.ts'), `export const openApiOperations = ${JSON.stringify(Object.fromEntries(paths.map(path =>
        [path, { get: { exposure: 'public', rateLimitFamily: 'read' } }])))};
        const app = { get() {} };
        ${paths.map(path => `app.get('${path}', () => null);`).join('\n')}`);
      const brief = parseBrief(readFileSync(repo.brief(['operations: [/widgets, /widgets/1]']), 'utf8'));
      const handover = await prepareHandover(brief, 'brief text', repo.dir);
      expect(handover.operations.split('\n').length).toBeLessThanOrEqual(60);
      expect(handover.operations).toContain('Operation query: /widgets\n');
      expect(handover.operations).toContain('Operation query: /widgets/1\n');
      expect(handover.operations).toContain('[truncated; narrow the query]');
    } finally { repo.dispose(); }
  });

  test('wait reports claimed stray writes, preserves them and excludes files outside the claim', async () => {
    const repo = repository();
    try {
      const ref = repo.reference('reference.txt');
      expect(repo.run('dispatch', repo.brief([`refs: [${ref}]`])).status).toBe(0);
      await repo.record(repo.ledger().tasks['G-001']!);
      const ledger = repo.ledger();
      const task = ledger.tasks['G-001']!;
      task.state = 'exited';
      task.attempts[0]!.pid = 0;
      task.settlement = { attempt: 1, token: 'settled', owner: { pid: 0 }, settledAt: new Date().toISOString(), reason: 'fixture settled' };
      repo.save(ledger);
      writeFileSync(join(repo.dir, 'claimed.ts'), 'stray modification\n');
      writeFileSync(join(repo.dir, 'new file.ts'), 'stray untracked\n');
      writeFileSync(join(repo.dir, 'outside.ts'), 'outside claim\n');
      expect(strayFiles(task, repo.dir)).toEqual(['claimed.ts', 'new file.ts']);
      const result = repo.run('wait', 'G-001');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stray writes in the main checkout:\n  claimed.ts\n  new file.ts');
      expect(result.stdout).not.toContain('outside.ts');
      expect(readFileSync(join(repo.dir, 'claimed.ts'), 'utf8')).toBe('stray modification\n');
      expect(existsSync(join(repo.dir, 'new file.ts'))).toBe(true);
    } finally { repo.dispose(); }
  });

  test('stray writes retain both sides of a rename and literal names', () => {
    const repo = repository();
    try {
      repo.git('mv', 'claimed.ts', 'new "name".ts');
      expect(strayFiles({ paths: ['claimed.ts', 'new*.ts'] }, repo.dir)).toEqual(['claimed.ts', 'new "name".ts']);
    } finally { repo.dispose(); }
  });

  test('sol validates, chooses the weekly allowance and handles reset or missing figures', () => {
    const brief = parseBrief('---\nid: G-001\nkind: tooling\ntitle: Sol\nengine: sol\neffort: ultra\n---\n');
    expect(validateBrief(brief)).toEqual([]);
    const accounts: AccountUsage[] = [
      { account: 'codex', home: 'one', engines: ['codex'], used: 20, weekUsed: 90 },
      { account: 'codex-1', home: 'two', engines: ['codex-1'], used: 80, weekUsed: 40 },
    ];
    expect(solAccount(accounts)).toBe('codex-1');
    expect(solAccount(accounts.map(account => ({ ...account, weekUsed: 40 })))).toBe('codex');
    expect(solAccount(accounts.map(account => ({ ...account, weekUsed: undefined })))).toBe('codex');
    const now = Date.now();
    const usage = (resets: number) => JSON.stringify({ payload: { rate_limits: {
      primary: { used_percent: 95, window_minutes: 300, resets_at: now / 1000 + 60 },
      secondary: { used_percent: 70, window_minutes: 10080, resets_at: resets },
    } } });
    expect(parseCodexUsage(usage(now / 1000 + 60), now)).toMatchObject({ used: 95, weekUsed: 70 });
    expect(parseCodexUsage(usage(now / 1000 - 1), now)).toMatchObject({ used: 95, weekUsed: 0 });
  });

  test('worker launch disables subagents for engines with supported controls, fresh and resumed', () => {
    for (const resume of [false, true]) {
      for (const engine of ['claude', 'sonnet', 'haiku', 'fable'] as const) {
        const [, args] = launchCommand({ id: 'G-001', effort: 'high', session: 's', prompt: 'p', engine, resume });
        expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', 'Agent']);
      }
      for (const engine of ['codex', 'codex-1', 'luna'] as const) {
        const [, args] = launchCommand({ id: 'G-001', effort: 'high', session: 's', prompt: 'p', engine, resume });
        expect(args).toContain('features.multi_agent=false');
        expect(args).toContain('features.multi_agent_v2=false');
      }
      expect(launchCommand({ id: 'G-001', effort: 'high', session: 's', prompt: 'p', engine: 'grok', resume })[1]).toContain('--no-subagents');
    }
  });
});
