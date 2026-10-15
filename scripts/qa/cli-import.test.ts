import { expect, test } from 'bun:test';

test('the QA command reaches argument validation outside a test runner without registering persona hooks', () => {
  const child = Bun.spawnSync(['bun', 'scripts/qa/cli.ts', '--invalid-import-probe'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined },
    stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain('Unsupported QA option: --invalid-import-probe');
});
