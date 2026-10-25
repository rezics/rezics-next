import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './test-support.ts';

const leaked = { GOAL_DATABASE_PATH: '/live/goal.sqlite', GOAL_STATE_DIRECTORY: '/live', GOAL_MANAGER: 'kernel', CODEX_THREAD_ID: 'live' };

test('tests started from a worker environment do not see the live control plane', () => {
  for (const cwd of [join(import.meta.dir, '..'), join(import.meta.dir, '../../..')]) {
    const result = spawnSync(process.execPath, ['test', join(import.meta.dir, 'fixtures/environment-probe.test.ts')],
      { cwd, env: { ...process.env, ...leaked }, encoding: 'utf8' });
    expect(`${cwd}: ${result.status}`).toBe(`${cwd}: 0`);
  }
});

test('git in a test directory that is not a repository fails instead of reaching the enclosing checkout', () => {
  const t = temporaryDirectory();
  try {
    const plain = join(t.path, 'plain'); mkdirSync(plain);
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  } finally { t.close(); }
});
