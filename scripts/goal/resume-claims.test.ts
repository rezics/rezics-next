import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief } from './briefs.ts';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';
import type { Ledger, Task } from './types.ts';

const spawnSync = fixtureSpawns(10_000);
const cli = join(import.meta.dir, 'goalctl.ts');

function repository() {
  const scratch = join(import.meta.dir, '../../.temp');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'resume-claims-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'goal@example.invalid');
  git('config', 'user.name', 'resume claims fixture');
  writeFileSync(join(dir, '.gitignore'), '.temp/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const local = join(dir, '.temp');
  const briefPath = join(local, 'brief.md');
  const brief = (fields: Record<string, string> = {}) => {
    const values = { id: 'G-001', kind: 'tooling', title: 'Resume claims', engine: 'codex', effort: 'high',
      paths: '[kept.ts, dropped.ts]', ...fields };
    const text = ['---', ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
      '---', '', '## Outcome', '', 'Continue the assigned work.', '', '## Mechanisms', '', 'none', ''].join('\n');
    writeFileSync(briefPath, text);
    return text;
  };
  mkdirSync(local, { recursive: true });
  const text = brief();
  const worktree = join(local, 'worktree');
  git('worktree', 'add', '-qb', 'goal/claims', worktree);
  mkdirSync(join(worktree, '.temp/goal'), { recursive: true });
  writeFileSync(join(worktree, '.temp/goal/brief.md'), text);
  const state = join(local, 'goal-orchestration');
  mkdirSync(state, { recursive: true });
  const output = join(state, 'old.json');
  writeFileSync(output, '');
  const task: Task = { ...parseBrief(text), brief: briefPath, worktree, branch: 'goal/claims',
    base: git('rev-parse', 'main'), state: 'stopped', attempts: [{ n: 1, engine: 'codex', effort: 'high',
      pid: 0, session: '', output, round: 'initial', startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z' }] };
  const ledgerPath = join(state, 'ledger.json');
  const save = (ledger: Ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger));
  save({ manager: 'fixture-manager', tasks: { [task.id]: task } });
  const bin = join(local, 'bin');
  mkdirSync(bin, { recursive: true });
  // Inject the existing CLI launcher through PATH: observe the handover, then exit without a worker.
  const launcher = join(bin, 'codex');
  writeFileSync(launcher, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('.temp/launched.json', JSON.stringify({ brief: readFileSync('.temp/goal/brief.md', 'utf8'),
  prompt: process.argv.at(-1) }));
`);
  chmodSync(launcher, 0o755);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, GOAL_ID: '', GOAL_TASK_ID: '', GOAL_MAX_WORKERS: '25',
      GOAL_MEMORY_FLOOR_GIB: '0', GOAL_CODEX_HOME: join(local, 'codex'), GOAL_CODEX_1_HOME: join(local, 'codex-1'),
      GOAL_USAGE_FILE: join(local, 'usage.json') } });
  const ledger = (): Ledger => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  const launchedPath = join(worktree, '.temp/launched.json');
  const launched = async () => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(launchedPath)) {
      if (Date.now() > deadline) throw new Error('Injected launcher did not record the handover');
      await Bun.sleep(10);
    }
    return JSON.parse(readFileSync(launchedPath, 'utf8')) as { brief: string; prompt: string };
  };
  return { dir, task, brief, briefPath, run, save, ledger, ledgerPath, launchedPath, launched,
    dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resume registers brief claims', () => {
  test.each([
    ['a path added', { paths: '[kept.ts, dropped.ts, added.ts]' }, 'paths'],
    ['a path dropped', { paths: '[kept.ts]' }, 'paths'],
    ['a dependency added', { depends: '[G-002]' }, 'depends'],
  ] as const)('%s is registered with the resume and delivered to the launcher', async (_name, fields, changed) => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.tasks['G-002'] = { ...repo.task, id: 'G-002', paths: ['dependency.ts'], state: 'verified' };
      repo.save(ledger);
      const text = repo.brief(fields);
      const result = repo.run('resume', repo.task.id, '-m', 'Continue.');
      expect(result.status).toBe(0);
      const current = repo.ledger().tasks[repo.task.id]!;
      expect(current[changed]).toEqual(parseBrief(text)[changed]);
      expect(current.attempts).toHaveLength(2);
      expect(result.stdout.split('\n').filter(line => line.includes('claims updated:'))).toEqual([
        `${repo.task.id} claims updated: ${changed}`,
      ]);
      const observed = await repo.launched();
      expect(observed.brief).toBe(text);
      expect(observed.prompt).toContain(text);
    } finally { repo.dispose(); }
  });

  test('registers the remaining fields reclaim assigns and stages newly claimed references', async () => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.tasks[repo.task.id]!.operations = ['old-query'];
      repo.save(ledger);
      writeFileSync(join(repo.dir, 'evidence.md'), 'new evidence');
      const text = repo.brief({ kind: 'surface', rows: '[program/resume]', title: 'Updated claims', effort: 'medium',
        cases: '[API01]', tests: '[proof.test.ts]', refs: '[evidence.md]', migrations: '[main:001-002]', shared: '[types.ts]', land: 'auto' });
      const result = repo.run('resume', repo.task.id, '-m', 'Continue.');
      expect(result.status).toBe(0);
      const current = repo.ledger().tasks[repo.task.id]!;
      const expected = parseBrief(text);
      for (const key of ['kind', 'rows', 'title', 'effort', 'cases', 'tests', 'refs', 'operations',
        'migrations', 'shared', 'land'] as const) expect(current[key]).toEqual(expected[key]);
      expect(result.stdout).toContain('claims updated: kind, rows, title, effort, cases, tests, refs, operations, migrations, shared, land');
      expect((await repo.launched()).brief).toBe(text);
      expect(readFileSync(join(repo.task.worktree, '.temp/ref/evidence.md'), 'utf8')).toBe('new evidence');
    } finally { repo.dispose(); }
  });

  test('a conflict refuses with reclaim diagnostics, preserves the ledger and starts no launcher', () => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.tasks['G-002'] = { ...repo.task, id: 'G-002', paths: ['added.ts'] };
      repo.save(ledger);
      repo.brief({ paths: '[kept.ts, added.ts]' });
      const before = readFileSync(repo.ledgerPath, 'utf8');
      const workerBrief = readFileSync(join(repo.task.worktree, '.temp/goal/brief.md'), 'utf8');
      const resumed = repo.run('resume', repo.task.id, '-m', 'Continue.');
      const reclaimed = repo.run('reclaim', repo.task.id, repo.briefPath);
      expect(resumed.status).toBe(1);
      expect(resumed.stderr).toBe(reclaimed.stderr);
      expect(resumed.stderr).toContain('Claim conflict for G-001:');
      expect(resumed.stderr).toContain('G-002');
      expect(readFileSync(repo.ledgerPath, 'utf8')).toBe(before);
      expect(readFileSync(join(repo.task.worktree, '.temp/goal/brief.md'), 'utf8')).toBe(workerBrief);
      expect(existsSync(repo.launchedPath)).toBe(false);
    } finally { repo.dispose(); }
  });

  test('registers a relocated main brief and clears an optional claim it no longer states', async () => {
    const repo = repository();
    try {
      const ledger = repo.ledger();
      ledger.tasks[repo.task.id]!.brief = join(repo.dir, 'missing.md');
      ledger.tasks[repo.task.id]!.land = 'auto';
      repo.save(ledger);
      const text = repo.brief();
      const relocated = join(repo.dir, 'docs/goals/tasks', `${repo.task.id}.md`);
      mkdirSync(join(repo.dir, 'docs/goals/tasks'), { recursive: true });
      writeFileSync(relocated, text);
      const result = repo.run('resume', repo.task.id, '-m', 'Continue.');
      expect(result.status).toBe(0);
      expect(repo.ledger().tasks[repo.task.id]!.brief).toBe(relocated);
      expect(repo.ledger().tasks[repo.task.id]!.land).toBeUndefined();
      expect(result.stdout).toContain('claims updated: brief, land');
      expect((await repo.launched()).brief).toBe(text);
    } finally { repo.dispose(); }
  });

  test.each([
    ['invalid fields', { title: '', kind: 'invalid' }, ['title is required', 'kind must be one of']],
    ['invalid mechanisms', {}, ['brief needs a ## Mechanisms section']],
  ] as const)('%s refuse with validation errors and no ledger change or launch', (_name, fields, errors) => {
    const repo = repository();
    try {
      const text = repo.brief(fields);
      if (_name === 'invalid mechanisms') writeFileSync(repo.briefPath, text.split('## Mechanisms')[0]!);
      const before = readFileSync(repo.ledgerPath, 'utf8');
      const result = repo.run('resume', repo.task.id, '-m', 'Continue.');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid brief');
      for (const error of errors) expect(result.stderr).toContain(error);
      expect(readFileSync(repo.ledgerPath, 'utf8')).toBe(before);
      expect(existsSync(repo.launchedPath)).toBe(false);
    } finally { repo.dispose(); }
  });

  test('an unchanged brief preserves claims and adds no claim output', async () => {
    const repo = repository();
    try {
      const result = repo.run('resume', repo.task.id, '-m', 'Continue.');
      expect(result.status).toBe(0);
      const current = repo.ledger().tasks[repo.task.id]!;
      const { state: _state, attempts: _attempts, ...claims } = current;
      const { state: _oldState, attempts: _oldAttempts, ...oldClaims } = repo.task;
      expect(claims).toEqual(oldClaims);
      expect(result.stdout).not.toContain('claims updated:');
      expect((await repo.launched()).brief).toBe(readFileSync(repo.briefPath, 'utf8'));
    } finally { repo.dispose(); }
  });
});
