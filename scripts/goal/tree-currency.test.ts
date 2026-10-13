import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCheckTree, warnHarnessCurrency } from './tree-currency.ts';

const scratch = join(import.meta.dir, '../../.temp/tree-currency-tests');
const fixtures: string[] = [];

function repository() {
  mkdirSync(scratch, { recursive: true });
  const main = mkdtempSync(join(scratch, 'repo-'));
  fixtures.push(main);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const write = (cwd: string, file: string, content: string) => {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  const commit = (file: string, content: string) => {
    write(main, file, content);
    git(main, 'add', file);
    git(main, 'commit', '-qm', `Change ${file}`);
    return git(main, 'rev-parse', 'HEAD');
  };
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'currency@example.invalid');
  git(main, 'config', 'user.name', 'currency test');
  write(main, '.gitignore', '.temp/\n');
  write(main, 'scripts/goal/goalctl.ts', "console.log('old harness');\n");
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'Initial tree');
  const cwd = join(main, '.temp/worker');
  git(main, 'worktree', 'add', '-qb', 'goal/worker', cwd);
  return { main, cwd, git, write, commit };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each(['scripts/goal/fix.ts', 'scripts/qa/fix.ts', 'tests/qa/support/fix.ts'])('warns for missing ancestry under %s without moving the tree', path => {
  const r = repository();
  const before = r.git(r.cwd, 'rev-parse', 'HEAD');
  r.commit('ordinary.ts', 'export {};\n');
  const lines: string[] = [];
  expect(warnHarnessCurrency(r.cwd, line => lines.push(line))).toBe(0);
  expect(lines).toEqual([]);
  r.commit(path, 'export {};\n');
  r.commit('scripts/qa/another.ts', 'export {};\n');
  expect(warnHarnessCurrency(r.cwd, line => lines.push(line))).toBe(2);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('2 commits behind main');
  expect(lines[0]).toContain('a harness failure on this tree may already be fixed');
  expect(lines[0]).toContain('Commit your changes, run task goal -- check or rebase onto main, and run again');
  expect(r.git(r.cwd, 'rev-parse', 'HEAD')).toBe(before);
});

test('a tree with the last harness commit is current even with later unrelated main commits', () => {
  const r = repository();
  const fix = r.commit('scripts/qa/fix.ts', 'export {};\n');
  r.git(r.cwd, 'merge', '--ff-only', fix);
  r.commit('ordinary.ts', 'export {};\n');
  const lines: string[] = [];
  expect(warnHarnessCurrency(r.cwd, line => lines.push(line))).toBe(0);
  expect(lines).toEqual([]);
});

test('equivalent patches without ancestry still warn', () => {
  const r = repository();
  const fix = r.commit('scripts/qa/fix.ts', 'export {};\n');
  r.write(r.cwd, 'own.ts', 'export {};\n');
  r.git(r.cwd, 'add', 'own.ts');
  r.git(r.cwd, 'commit', '-qm', 'Worker change');
  r.git(r.cwd, 'cherry-pick', fix);
  expect(warnHarnessCurrency(r.cwd, () => {})).toBe(1);
});

test.each(['main', 'pinned'])('%s checkout is never compared with main or moved', kind => {
  const r = repository();
  const cwd = kind === 'main' ? r.main : r.cwd;
  if (kind === 'pinned') r.git(cwd, 'checkout', '--detach');
  const before = r.git(cwd, 'rev-parse', 'HEAD');
  // A missing main ref proves the exempt paths perform no main comparison at all.
  r.git(r.main, 'branch', '-m', 'main', 'renamed');
  const lines: string[] = [];
  expect(warnHarnessCurrency(cwd, line => lines.push(line))).toBe(0);
  expect(prepareCheckTree(cwd, line => lines.push(line))).toBeUndefined();
  expect(lines).toEqual([]);
  expect(r.git(cwd, 'rev-parse', 'HEAD')).toBe(before);
});

test.each(['test', 'slot'])('%s CLI warns before execution and still runs on a behind tree', command => {
  const r = repository();
  r.commit('ordinary.ts', 'export {};\n');
  r.write(r.cwd, 'scripts/qa/test.ts', "console.log('command ran');\n");
  const cli = join(import.meta.dir, 'goalctl.ts');
  const run = () => spawnSync(process.execPath, [cli, command, ...command === 'test'
    ? ['scripts/fixture.test.ts'] : ['--', process.execPath, 'scripts/qa/test.ts', 'scripts/fixture.test.ts']], {
    cwd: r.cwd, encoding: 'utf8', env: { ...process.env, GOAL_IN_SLOT: '1' }, timeout: 30_000,
  });
  const before = r.git(r.cwd, 'rev-parse', 'HEAD');
  const current = run();
  expect(current.status, current.stderr).toBe(0);
  expect(current.stdout).toContain('command ran');
  expect(current.stdout).not.toContain('Harness:');
  r.commit('scripts/qa/fix.ts', 'export {};\n');
  const stale = run();
  expect(stale.status, stale.stderr).toBe(0);
  expect(stale.stdout.match(/Harness:/g)).toHaveLength(1);
  expect(stale.stdout.indexOf('Harness:')).toBeLessThan(stale.stdout.indexOf('command ran'));
  expect(r.git(r.cwd, 'rev-parse', 'HEAD')).toBe(before);
}, 30_000);

test('check CLI reloads the updated worktree harness after preparing the tree', () => {
  const r = repository();
  const main = r.commit('scripts/goal/goalctl.ts', "console.log('updated harness ran');\n");
  const result = spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), 'check', '--only', 'tests'], {
    cwd: r.cwd, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('fast-forwarded');
  expect(result.stdout).toContain('updated harness ran');
  expect(result.stdout).not.toContain('old harness');
  expect(r.git(r.cwd, 'rev-parse', 'HEAD')).toBe(main);
  expect(readFileSync(join(r.cwd, 'scripts/goal/goalctl.ts'), 'utf8')).toContain('updated harness');
}, 30_000);
