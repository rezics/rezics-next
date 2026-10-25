import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const leaked = { GOAL_DATABASE_PATH: '/live/goal.sqlite', GOAL_STATE_DIRECTORY: '/live', GOAL_MANAGER: 'kernel', CODEX_THREAD_ID: 'live' };

test('tests started from a worker environment do not see the live control plane', () => {
  for (const cwd of [join(import.meta.dir, '..'), join(import.meta.dir, '../../..')]) {
    const result = spawnSync(process.execPath, ['test', join(import.meta.dir, 'fixtures/environment-probe.test.ts')],
      { cwd, env: { ...process.env, ...leaked }, encoding: 'utf8' });
    expect(`${cwd}: ${result.status}`).toBe(`${cwd}: 0`);
  }
});
