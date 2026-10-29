import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './test-support.ts';

const leaked = {
  GOAL_DATABASE_PATH: '/live/goal.sqlite',
  GOAL_STATE_DIRECTORY: '/live',
  GOAL_MANAGER: 'kernel',
  CODEX_THREAD_ID: 'live',
};

test('tests started from a worker environment do not see the live control plane', () => {
  for (const cwd of [join(import.meta.dir, '..'), join(import.meta.dir, '../../..')]) {
    const result = spawnSync(process.execPath, ['test', join(import.meta.dir, 'fixtures/environment-probe.test.ts')], {
      cwd,
      env: { ...process.env, ...leaked },
      encoding: 'utf8',
    });
    expect(`${cwd}: ${result.status}`).toBe(`${cwd}: 0`);
  }
});

test('tests started on a developer host do not inherit its check-host routing', () => {
  const t = temporaryDirectory();
  try {
    writeFileSync(
      join(t.path, 'bunfig.toml'),
      `[test]\npreload = [${JSON.stringify(join(import.meta.dir, 'test-environment.ts'))}]\n`,
    );
    writeFileSync(
      join(t.path, 'routing.test.ts'),
      `
      import { expect, test } from 'bun:test';
      test('the test process carries no host check routing', () => {
        expect(process.env).not.toHaveProperty('KERNEL_CHECK_REMOTE');
        expect(process.env).not.toHaveProperty('KERNEL_CHECK_ON_REMOTE');
      });
    `,
    );
    const result = spawnSync(process.execPath, ['test', './routing.test.ts'], {
      cwd: t.path,
      env: { ...process.env, KERNEL_CHECK_REMOTE: '/host/check-hosts.json', KERNEL_CHECK_ON_REMOTE: '1' },
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    t.close();
  }
});

test('git in a test directory that is not a repository fails instead of reaching the enclosing checkout', () => {
  const t = temporaryDirectory();
  try {
    const plain = join(t.path, 'plain');
    mkdirSync(plain);
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  } finally {
    t.close();
  }
});

test('a test that runs git init under bisect run cannot reinitialise the repository that started it', () => {
  const t = temporaryDirectory();
  try {
    const repository = join(t.path, 'repository');
    mkdirSync(repository);
    expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0);
    writeFileSync(
      join(t.path, 'bunfig.toml'),
      `[test]\npreload = [${JSON.stringify(join(import.meta.dir, 'test-environment.ts'))}]\n`,
    );
    writeFileSync(
      join(t.path, 'init.test.ts'),
      `
      import { expect, test } from 'bun:test';
      import { spawnSync } from 'node:child_process';
      import { mkdtempSync } from 'node:fs';
      import { join } from 'node:path';
      test('git init in a scratch directory starts a new repository', () => {
        expect(process.env).not.toHaveProperty('GIT_DIR');
        const scratch = mkdtempSync(join(${JSON.stringify(t.path)}, 'scratch-'));
        expect(spawnSync('git', ['init', '-q'], { cwd: scratch }).status).toBe(0);
      });
    `,
    );
    // Git exports these to the commands that bisect run, rebase --exec and hooks start.
    const result = spawnSync(process.execPath, ['test', './init.test.ts'], {
      cwd: t.path,
      env: { ...process.env, GIT_DIR: join(repository, '.git'), GIT_WORK_TREE: repository, GIT_PREFIX: '' },
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const bare = spawnSync('git', ['config', 'core.bare'], { cwd: repository, encoding: 'utf8' });
    expect(bare.stdout.trim()).toBe('false');
  } finally {
    t.close();
  }
});
