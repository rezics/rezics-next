import { expect, test } from 'bun:test';

test('the QA command loads outside a test runner without registering persona hooks', () => {
  const child = Bun.spawnSync(['bun', '--eval', "await import('./scripts/qa/cli.ts')"], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
});
