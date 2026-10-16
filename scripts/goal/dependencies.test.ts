import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependencyInstallIsStale, ensureDependencies, recordDependencyInstall } from './dependencies.ts';

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = join(import.meta.dir, '../../.temp/dependency-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root);
  mkdirSync(join(root, '.temp/bin'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.temp/\nnode_modules/\n');
  writeFileSync(join(root, 'yarn.lock'), 'version one');
  writeFileSync(join(root, 'package.json'), '{}');
  const installer = join(root, '.temp/bin/task');
  writeFileSync(installer, '#!/bin/sh\n[ "$1" = install ] || exit 2\nprintf "%s\\n" "$PWD" >> "' + root + '/.temp/installs"\n[ ! -f .temp/fail ]\n');
  chmodSync(installer, 0o755);
  process.env.PATH = `${join(root, '.temp/bin')}:${originalPath}`;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git(root, 'init', '-qb', 'main'); git(root, 'config', 'user.name', 'Dependencies'); git(root, 'config', 'user.email', 'deps@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  return { root, git, installs: () => existsSync(join(root, '.temp/installs')) ? readFileSync(join(root, '.temp/installs'), 'utf8').trim().split('\n') : [] };
}

test('a landed lockfile refreshes main, and a stale rebased checkout installs independently', () => {
  const f = fixture();
  const worker = join(f.root, '.temp/worker');
  const stale = join(f.root, '.temp/stale');
  f.git(f.root, 'worktree', 'add', '-qb', 'stale', stale);
  f.git(f.root, 'worktree', 'add', '-qb', 'worker', worker);
  recordDependencyInstall(f.root); recordDependencyInstall(worker); recordDependencyInstall(stale);
  writeFileSync(join(worker, 'yarn.lock'), 'version two');
  f.git(worker, 'commit', '-am', 'upgrade');
  f.git(f.root, 'merge', '--ff-only', 'worker');
  ensureDependencies(f.root);
  expect(f.installs()).toEqual([f.root]);
  expect(dependencyInstallIsStale(stale)).toBe(false);
  f.git(stale, 'rebase', 'main');
  expect(dependencyInstallIsStale(stale)).toBe(true);
  ensureDependencies(stale);
  expect(f.installs()).toEqual([f.root, stale]);
  ensureDependencies(f.root); ensureDependencies(stale);
  expect(f.installs()).toHaveLength(2);
});

test('content changes invalidate old timestamps, package manifests and patches; unchanged content does not install', () => {
  const f = fixture();
  expect(dependencyInstallIsStale(f.root)).toBe(true);
  ensureDependencies(f.root);
  utimesSync(join(f.root, 'yarn.lock'), 1, 1);
  ensureDependencies(f.root); expect(f.installs()).toHaveLength(1);
  mkdirSync(join(f.root, '.temp/snapshot'), { recursive: true });
  writeFileSync(join(f.root, '.temp/snapshot/package.json'), '{}');
  ensureDependencies(f.root); expect(f.installs()).toHaveLength(1);
  writeFileSync(join(f.root, 'yarn.lock'), 'new'); utimesSync(join(f.root, 'yarn.lock'), 1, 1);
  ensureDependencies(f.root); expect(f.installs()).toHaveLength(2);
  mkdirSync(join(f.root, 'packages/example'), { recursive: true });
  writeFileSync(join(f.root, 'packages/example/package.json'), '{}');
  ensureDependencies(f.root); expect(f.installs()).toHaveLength(3);
  mkdirSync(join(f.root, '.yarn/patches'), { recursive: true });
  writeFileSync(join(f.root, '.yarn/patches/example.patch'), 'patch');
  ensureDependencies(f.root); expect(f.installs()).toHaveLength(4);
});

test('failed installs remain stale and retry before any caller can proceed', () => {
  const f = fixture(); recordDependencyInstall(f.root);
  writeFileSync(join(f.root, 'yarn.lock'), 'upgrade');
  writeFileSync(join(f.root, '.temp/fail'), '');
  expect(() => ensureDependencies(f.root)).toThrow('Dependency install failed');
  expect(dependencyInstallIsStale(f.root)).toBe(true);
  rmSync(join(f.root, '.temp/fail'));
  ensureDependencies(f.root);
  expect(dependencyInstallIsStale(f.root)).toBe(false);
});
