import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { installMainGuard, mainGuardStatus, MAIN_GUARD_REFUSAL, removeMainGuard } from './main-guard.ts';

function fixture(run: (repo: string, worktree: string, git: (cwd: string, ...args: string[]) => string) => void): void {
  const temporary = join(import.meta.dir, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'main-guard-'));
  const repo = join(directory, 'repository with spaces');
  const worktree = join(directory, 'second worktree');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  try {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'main-guard@example.invalid');
    git(repo, 'config', 'user.name', 'Main guard test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'core.hooksPath', join(repo, '.git/hooks'));
    git(repo, 'commit', '--allow-empty', '-qm', 'Initial');
    git(repo, 'commit', '--allow-empty', '-qm', 'Reached main');
    git(repo, 'worktree', 'add', '-qb', 'goal/task', worktree, 'HEAD~1');
    run(repo, worktree, git);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function refused(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr.split('\n').filter(line => line === MAIN_GUARD_REFUSAL)).toHaveLength(1);
}

describe('main retains every commit that reached it from every worktree', () => {
  for (const linked of [false, true]) {
    for (const operation of ['amend', 'rebase', 'reset', 'force'] as const) {
      test(`${operation} is refused from the ${linked ? 'linked' : 'main'} worktree`, () => fixture((repo, worktree, git) => {
        installMainGuard(worktree);
        const tip = git(repo, 'rev-parse', 'main');
        const cwd = linked ? worktree : repo;
        if (linked && operation !== 'force') {
          git(repo, 'switch', '--detach');
          git(worktree, 'switch', 'main');
        }
        const args = operation === 'amend' ? ['commit', '--amend', '--allow-empty', '-qm', 'Correction']
          : operation === 'rebase' ? ['rebase', '--onto', 'main~1', 'main', 'main']
            : operation === 'reset' ? ['reset', '--hard', 'main~1']
              : ['branch', '--force', 'main', 'main~1'];
        // Git itself refuses `branch -f` for a checked-out branch before a hook can run.
        if (operation === 'force') git(repo, 'switch', '--detach');
        refused(cwd, args);
        expect(git(repo, 'rev-parse', 'main')).toBe(tip);
      }));
    }
  }

  test('new commits, fast-forward landings and unrelated reference rewrites pass', () => fixture((repo, worktree, git) => {
    installMainGuard(worktree);
    git(repo, 'commit', '--allow-empty', '-qm', 'Correction as a new commit');
    git(worktree, 'commit', '--allow-empty', '-qm', 'Task work');
    git(worktree, 'rebase', 'main');
    git(repo, 'merge', '--ff-only', 'goal/task');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'goal/task'));
    git(worktree, 'commit', '--amend', '--allow-empty', '-qm', 'Task rewrite');
    git(worktree, 'reset', '--hard', 'HEAD~1');
    git(repo, 'update-ref', 'refs/heads/archive/goals', 'main');
    git(worktree, 'update-ref', 'refs/heads/archive/goals', 'main~1');
    git(worktree, 'update-ref', '-d', 'refs/heads/archive/goals');
    git(worktree, 'update-ref', 'refs/tags/main', 'main');
    git(worktree, 'update-ref', 'refs/tags/main', 'main~1');
  }));

  test('unconditional updates and deletion cannot erase main, including a multi-reference transaction', () => fixture((repo, worktree, git) => {
    installMainGuard(repo);
    const tip = git(repo, 'rev-parse', 'main');
    const parent = git(repo, 'rev-parse', 'main~1');
    for (const cwd of [repo, worktree]) {
      refused(cwd, ['update-ref', 'refs/heads/main', parent]);
      refused(cwd, ['update-ref', '-d', 'refs/heads/main']);
      const result = spawnSync('git', ['update-ref', '--stdin'], { cwd, encoding: 'utf8', timeout: 10_000,
        input: `start\nupdate refs/heads/archive/goals ${parent}\nupdate refs/heads/main ${parent}\nprepare\ncommit\n` });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(MAIN_GUARD_REFUSAL);
      expect(git(repo, 'rev-parse', 'main')).toBe(tip);
      expect(spawnSync('git', ['show-ref', '--verify', 'refs/heads/archive/goals'], { cwd, timeout: 10_000 }).status).not.toBe(0);
    }
  }));

  test('creating main when the reference does not yet exist is allowed', () => fixture((repo, worktree, git) => {
    git(repo, 'switch', '--detach');
    git(repo, 'branch', '-D', 'main');
    installMainGuard(worktree);
    git(worktree, 'update-ref', 'refs/heads/main', 'HEAD');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(worktree, 'rev-parse', 'HEAD'));
  }));

  test('unrelated references need no Git process; main checks only the supplied ancestry pair', () => fixture((repo, _worktree, git) => {
    const installed = installMainGuard(repo);
    const tip = git(repo, 'rev-parse', 'main');
    const parent = git(repo, 'rev-parse', 'main~1');
    const started = performance.now();
    for (let index = 0; index < 20; index++) {
      const result = spawnSync(installed.hook, ['prepared'], { cwd: repo, encoding: 'utf8', timeout: 10_000,
        input: `${tip} ${parent} refs/heads/goal/task\n${tip} ${parent} HEAD\n`, env: { ...process.env, PATH: '' } });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
    console.info(`Unrelated-reference hook: ${((performance.now() - started) / 20).toFixed(2)} ms per invocation (20 samples)`);
    const trace = join(repo, '.git/guard-trace');
    const result = spawnSync(installed.hook, ['prepared'], { cwd: repo, encoding: 'utf8', timeout: 10_000,
      input: `${parent} ${tip} refs/heads/main\n`, env: { ...process.env, GIT_TRACE: trace } });
    expect(result.status).toBe(0);
    const commands = readFileSync(trace, 'utf8').trim().split('\n');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`git merge-base --is-ancestor ${parent} ${tip}`);
  }));
});

describe('shared hook lifecycle', () => {
  test('install twice, status from both worktrees and remove are idempotent', () => fixture((repo, worktree, git) => {
    expect(mainGuardStatus(worktree).state).toBe('absent');
    const installed = installMainGuard(worktree);
    expect(installed.state).toBe('installed');
    expect(installed.hook).toBe(join(repo, '.git/hooks/reference-transaction'));
    expect(mainGuardStatus(repo)).toEqual(installed);
    const contents = readFileSync(installed.hook, 'utf8');
    expect(installMainGuard(repo)).toEqual(installed);
    expect(readFileSync(installed.hook, 'utf8')).toBe(contents);
    expect(statSync(installed.hook).mode & 0o111).not.toBe(0);
    expect(removeMainGuard(worktree).state).toBe('absent');
    expect(existsSync(installed.hook)).toBe(false);
    expect(removeMainGuard(repo).state).toBe('absent');
    git(repo, 'commit', '--amend', '--allow-empty', '-qm', 'No guard');
  }));

  test('an existing hook retains its contents, input, phases, refusal and permissions', () => fixture((repo, worktree, git) => {
    const hook = join(repo, '.git/hooks/reference-transaction');
    const calls = join(repo, '.git/hook-calls');
    const original = '#!/bin/sh\nupdates=$(cat)\nprintf "%s:%s\\n" "$1" "$updates" >> "$(git rev-parse --git-common-dir)/hook-calls"\ncase "$updates" in *refs/heads/forbidden*) exit 1;; esac\n';
    writeFileSync(hook, original, { mode: 0o751 });
    chmodSync(hook, 0o751);
    const installed = installMainGuard(worktree);
    expect(installed.previousHook).toBe(`${hook}.rezics-main-guard.previous`);
    expect(readFileSync(installed.previousHook!, 'utf8')).toBe(original);
    git(repo, 'commit', '--allow-empty', '-qm', 'Forward');
    const input = readFileSync(calls, 'utf8');
    expect(input).toMatch(/prepared:.* refs\/heads\/main/);
    expect(input).toMatch(/committed:.* refs\/heads\/main/);
    expect(spawnSync('git', ['update-ref', 'refs/heads/forbidden', 'main'], { cwd: worktree, timeout: 10_000 }).status).not.toBe(0);
    refused(worktree, ['update-ref', 'refs/heads/main', 'main~1']);
    expect(installMainGuard(repo)).toEqual(installed);
    expect(removeMainGuard(repo).state).toBe('absent');
    expect(readFileSync(hook, 'utf8')).toBe(original);
    expect(statSync(hook).mode & 0o777).toBe(0o751);
    expect(existsSync(installed.previousHook!)).toBe(false);
    git(repo, 'commit', '--amend', '--allow-empty', '-qm', 'Restored hook');
  }));

  test('modified installations and backup collisions are never overwritten', () => fixture((repo, _worktree) => {
    const installed = installMainGuard(repo);
    const changed = `${readFileSync(installed.hook, 'utf8')}# Another owner changed this hook\n`;
    writeFileSync(installed.hook, changed);
    expect(mainGuardStatus(repo).state).toBe('modified');
    expect(() => installMainGuard(repo)).toThrow('modified');
    expect(() => removeMainGuard(repo)).toThrow('modified');
    expect(readFileSync(installed.hook, 'utf8')).toBe(changed);
    rmSync(installed.hook);
    const backup = `${installed.hook}.rezics-main-guard.previous`;
    writeFileSync(backup, 'Reserved by another owner\n');
    expect(() => installMainGuard(repo)).toThrow('already exists');
    expect(readFileSync(backup, 'utf8')).toBe('Reserved by another owner\n');
  }));

  test('a configured external hooks directory is reported and never silently changed', () => fixture((repo, worktree, git) => {
    const configured = join(repo, '.temp/custom-hooks');
    git(repo, 'config', 'core.hooksPath', configured);
    expect(mainGuardStatus(worktree).state).toBe('inactive');
    expect(() => installMainGuard(repo)).toThrow('core.hooksPath');
    expect(git(repo, 'config', '--get', 'core.hooksPath')).toBe(configured);
  }));

  test('disabled guard is reported and reinstallation restores execution', () => fixture((repo) => {
    const installed = installMainGuard(repo);
    chmodSync(installed.hook, 0o644);
    expect(mainGuardStatus(repo).state).toBe('inactive');
    expect(installMainGuard(repo).state).toBe('installed');
  }));

  test('goalctl discovers install, status and remove and reports the preserved hook', () => fixture((repo, worktree) => {
    const hook = join(repo, '.git/hooks/reference-transaction');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cli = (cwd: string, action: string) => spawnSync(process.execPath,
      [join(import.meta.dir, 'goalctl.ts'), 'main-guard', action], { cwd, encoding: 'utf8', timeout: 30_000 });
    for (const action of ['install', 'install', 'status']) {
      const result = cli(worktree, action);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('installed');
      expect(result.stdout).toContain('preserved');
      expect(result.stdout).toContain(`${hook}.rezics-main-guard.previous`);
    }
    expect(cli(repo, 'remove').status).toBe(0);
    expect(cli(worktree, 'status').stdout).toContain('absent');
    expect(cli(repo, 'invalid').status).toBe(2);
  }));
});
