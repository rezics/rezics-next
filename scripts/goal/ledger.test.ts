import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from './types.ts';

const fixtures: string[] = [];
const scratch = join(import.meta.dir, '../../.temp/ledger-tests');

function repository(wave: boolean) {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'repo-'));
  fixtures.push(directory);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = (cwd: string, file: string, content = 'export {};\n') => {
    writeFileSync(join(cwd, file), content);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', `Change ${file}`);
  };
  git(directory, 'init', '-qb', 'main');
  git(directory, 'config', 'user.email', 'ledger@example.invalid');
  git(directory, 'config', 'user.name', 'Ledger fixture');
  commit(directory, '.gitignore', '.temp/\n');
  if (wave) {
    git(directory, 'checkout', '-qb', 'wave/1');
    commit(directory, 'inherited.ts');
    git(directory, 'checkout', '-q', 'main');
  }
  const worktree = join(directory, '.temp/worker');
  const branch = 'goal/worker';
  git(directory, 'worktree', 'add', '-qb', branch, worktree, wave ? 'wave/1' : 'main');
  commit(worktree, 'claimed.ts');
  commit(worktree, 'own.ts');
  if (wave) {
    // The branch must be compared with its shared ancestor, not the newer wave tip.
    git(directory, 'checkout', '-q', 'wave/1');
    commit(directory, 'later.ts');
    git(directory, 'checkout', '-q', 'main');
  }
  const task: Task = { id: 'G-001', title: 'Worker', kind: 'tooling', effort: 'medium',
    cases: [], paths: ['claimed.ts'], migrations: [], shared: [], depends: [], attempts: [],
    worktree, branch, base: git(directory, 'rev-parse', 'main'), brief: '', state: 'exited', goal: 'program' };
  const state = join(directory, '.temp/goal-orchestration');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'ledger.json'), JSON.stringify({ tasks: { [task.id]: task },
    goals: { program: { manager: 'fixture-manager', startedAt: '2026-10-14T00:00:00Z' } } }));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), ...args],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, GOAL_ID: 'program' } });
  const changes = () => {
    // A fresh process binds ledger.root to this isolated repository, with real Git operations.
    const source = `import { unlandedChanges, unlandedChangers, readLedger } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))};
      const tasks = Object.values(readLedger().tasks);
      console.log(JSON.stringify({ changes: unlandedChanges(tasks),
        inherited: unlandedChangers(tasks, 'inherited.ts').map(task => task.id),
        own: unlandedChangers(tasks, 'own.ts').map(task => task.id) }));`;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: directory, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      changes: { worktree: string; branch: string; files: string[] }[]; inherited: string[]; own: string[];
    };
  };
  return { directory, worktree, branch, changes, run };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('a wave task holds only its own out-of-claim commits', () => {
  const r = repository(true);
  expect(r.changes()).toEqual({ changes: [{ worktree: r.worktree, branch: r.branch, files: ['own.ts'] }],
    inherited: [], own: ['G-001'] });
});

test.each([false, true])('a non-wave task keeps its held files (missing worktree=%s)', missing => {
  const r = repository(false);
  if (missing) rmSync(r.worktree, { recursive: true, force: true });
  expect(r.changes()).toEqual({ changes: [{ worktree: r.worktree, branch: r.branch, files: ['own.ts'] }],
    inherited: [], own: ['G-001'] });
});

test('dispatch admits a wave-changed path no wave task touched while refusing the task own change', () => {
  const r = repository(true);
  const brief = join(r.directory, '.temp/claim.md');
  for (const [path, status] of [['inherited.ts', 0], ['own.ts', 1]] as const) {
    writeFileSync(brief, ['---', 'id: G-002', 'title: Claim a path', 'kind: tooling', 'engine: sol',
      'effort: medium', `paths: [${path}]`, '---', '', '## Outcome', '', 'Claim the path.', '',
      '## Mechanisms', '', 'none', ''].join('\n'));
    const result = r.run('dispatch', brief, '--dry-run');
    expect(result.status, result.stderr).toBe(status);
    if (status === 0) expect(result.stdout).toContain('G-002: claims ok');
    else expect(result.stderr).toContain('path own.ts changed by G-001 (unlanded)');
  }
});
