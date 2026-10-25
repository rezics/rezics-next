import { expect, test } from 'bun:test';

// Run the entire immutable suite in a child, including its storage evidence tests.
test('the complete durable run-state outcomes pass with production indexed storage', async () => {
  const spec = 'specs/imports-run-store.test.ts';
  const declarations = (await Bun.file(spec).text()).match(/^test\(/gm)?.length ?? 0;
  expect(declarations).toBe(15);
  const child = Bun.spawn([process.execPath, 'test', spec], {
    env: { ...process.env, IMPORT_RUN_STORE_DRIVER: '../services/importer/tests/run-store-driver.ts' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  if (exit !== 0) console.error(output);
  expect(exit).toBe(0);
  expect(output).toMatch(new RegExp(`\\b${declarations} pass\\b`));
  expect(output).toMatch(/\b0 fail\b/);
  expect(output).not.toMatch(/\b[1-9]\d* (?:skip|todo)\b/i);
}, 120_000);
