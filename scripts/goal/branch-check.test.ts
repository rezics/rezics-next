import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { branchCheck } from './branch-check.ts';
import { type CheckRunner } from './check.ts';
const scratch = join(import.meta.dir, '../../.temp/branch-check-tests');
const roots: string[] = [];
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, 'case-')); roots.push(cwd);
  const write = (file: string, text: string) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), text); };
  const git = (...args: string[]) => { const run = spawnSync('git', args, { cwd, encoding: 'utf8' }); expect(run.status, run.stderr).toBe(0); return run.stdout.trim(); };
  write('.gitignore', '.temp/\nnode_modules/\n');
  write('services/main/tsconfig.json', '{}'); write('services/main/value.ts', 'export const value = "committed";');
  write('apps/web/tsconfig.json', '{}'); write('apps/web/page.ts', 'export {};');
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Branch check'); git('config', 'user.email', 'branch@example.invalid');
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'wave/1');
  const commands: string[][] = [];
  const trees: string[] = [];
  const runner: CheckRunner = async (command, tree) => {
    commands.push([...command]); trees.push(tree);
    expect(readFileSync(join(tree, 'services/main/value.ts'), 'utf8')).toContain('committed');
    return { code: 0, output: '' };
  };
  return { cwd, write, git, commands, trees, runner, print: () => {} };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('branch validation checks an immutable tip with full types, type-aware lint, AST and all guards', async () => {
  const f = fixture(); f.write('services/main/value.ts', 'export const value = "dirty";');
  const status = f.git('status', '--porcelain');
  const first = await branchCheck('wave/1', f);
  expect(first.code).toBe(0); expect(first.commit).toBe(f.git('rev-parse', 'wave/1'));
  expect(f.commands).toEqual([
    ['task', 'gen'], ['task', 'main:typecheck'], ['task', 'web:typecheck'],
    ['node_modules/.bin/oxlint', '--type-aware', 'apps', 'packages', 'services', 'scripts', 'tests', 'apphost',
      '--ignore-pattern', 'tests/fixtures/static-boundaries/lint-failing/**',
      '--ignore-pattern', 'tests/fixtures/static-boundaries/promise-failing/**'],
    ['task', 'ast-grep', '--', 'scan'], ['task', 'guards'],
  ]);
  expect(f.trees.every(tree => !existsSync(tree))).toBe(true);
  expect(await branchCheck('HEAD', f)).toEqual(first); expect(f.commands).toHaveLength(6);
  expect(f.git('status', '--porcelain')).toBe(status);
});

test('failures are recorded and a new commit runs independently', async () => {
  const f = fixture();
  const runner: CheckRunner = async (command, cwd, log) => {
    await f.runner(command, cwd, log); return { code: command[1] === 'main:typecheck' ? 1 : 0, output: 'error: bad type' };
  };
  const failed = await branchCheck('HEAD', { ...f, runner }); expect(failed.code).toBe(1);
  expect(await branchCheck('HEAD', f)).toEqual(failed); expect(f.commands).toHaveLength(6);
  f.write('services/main/new.ts', 'export {};'); f.git('add', '.'); f.git('commit', '-qm', 'next');
  const next = await branchCheck('HEAD', f); expect(next.code).toBe(0); expect(next.commit).not.toBe(failed.commit);
  expect(f.commands).toHaveLength(12);
});

test('simultaneous requests for the same tip share one validation', async () => {
  const f = fixture();
  const runner: CheckRunner = async (...args) => { await Bun.sleep(10); return f.runner(...args); };
  const [a, b] = await Promise.all([branchCheck('wave/1', { ...f, runner }), branchCheck('HEAD', { ...f, runner })]);
  expect(a).toEqual(b); expect(f.commands).toHaveLength(6);
});

test('invalid refs refuse without a result and generation failure cannot certify later checks', async () => {
  const f = fixture(); await expect(branchCheck('missing', f)).rejects.toThrow();
  const result = await branchCheck('HEAD', { ...f, runner: async () => ({ code: 1, output: 'error: generator failed' }) });
  expect(result.code).toBe(1); expect(result.checks.map(check => check.name)).toEqual(['contract']);
});

test('workspace dependency symlinks point at the checked snapshot', async () => {
  const f = fixture(); mkdirSync(join(f.cwd, 'node_modules/@rezics'), { recursive: true });
  symlinkSync('../../services/main', join(f.cwd, 'node_modules/@rezics/main'));
  await branchCheck('HEAD', { ...f, runner: async (command, tree, log) => {
    expect(realpathSync(join(tree, 'node_modules/@rezics/main'))).toBe(join(tree, 'services/main'));
    return f.runner(command, tree, log);
  } });
});

test('an abandoned lock is recovered without trusting a partial result', async () => {
  const f = fixture(); const commit = f.git('rev-parse', 'HEAD');
  f.write(`.temp/goal/branch-check/${commit}.lock`, '2147483647');
  f.write(`.temp/goal/branch-check/${commit}.json`, '{');
  expect((await branchCheck('HEAD', f)).code).toBe(0); expect(f.commands).toHaveLength(6);
});

test('guard reports survive snapshot cleanup and cached results keep their evidence', async () => {
  const f = fixture();
  const result = await branchCheck('HEAD', { ...f, runner: async (command, tree, log) => {
    if (command[1] === 'guards') {
      mkdirSync(join(tree, '.temp/repository-guards/run'), { recursive: true });
      writeFileSync(join(tree, '.temp/repository-guards/run/unit.xml'), '<testsuites/>');
    }
    return f.runner(command, tree, log);
  } });
  expect(readFileSync(join(result.log, '../guard-artifacts/run/unit.xml'), 'utf8')).toBe('<testsuites/>');
  expect(readFileSync(result.log, 'utf8')).toContain('Guard artifacts:');
});

test('Git-aware tools see the snapshot inventory and ordinary dependency directories do not loop', async () => {
  const f = fixture();
  mkdirSync(join(f.cwd, 'services/main/node_modules/.bin'), { recursive: true });
  writeFileSync(join(f.cwd, 'services/main/node_modules/.bin/tool'), '#!/bin/sh\nexit 0\n');
  await branchCheck('HEAD', { ...f, runner: async (command, tree, log) => {
    const tracked = spawnSync('git', ['ls-files'], { cwd: tree, encoding: 'utf8' });
    expect(tracked.status).toBe(0); expect(tracked.stdout).toContain('services/main/value.ts');
    expect(tracked.stdout).not.toContain('node_modules');
    expect(readFileSync(join(tree, 'services/main/node_modules/.bin/tool'), 'utf8')).toContain('exit 0');
    return f.runner(command, tree, log);
  } });
});

test('the about site uses its owning Astro checker and workspace directory', async () => {
  const f = fixture(); f.write('apps/about/tsconfig.json', '{}'); f.git('add', '.'); f.git('commit', '-qm', 'about');
  let checked = false;
  await branchCheck('HEAD', { ...f, runner: async (command, cwd, log) => {
    if (command[0] === 'node') { expect(command).toEqual(['node', 'astro-check.cjs']); expect(cwd.endsWith('/apps/about/')).toBe(true); checked = true; return { code: 0, output: '' }; }
    return f.runner(command, cwd, log);
  } });
  expect(checked).toBe(true);
});
