import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run the entire immutable suite in a child, including its storage evidence tests.
test('the complete durable run-state outcomes pass with production indexed storage', async () => {
  const spec = resolve(import.meta.dir, '../../../specs/imports-run-store.test.ts');
  const driver = resolve(import.meta.dir, 'run-store-driver.ts');
  const declarations = (await Bun.file(spec).text()).match(/^test\(/gm)?.length ?? 0;
  expect(declarations).toBeGreaterThanOrEqual(16);
  const cwd = mkdtempSync(join(tmpdir(), 'run-store-outcomes-'));
  try {
    const child = Bun.spawn([process.execPath, 'test', spec], {
      cwd,
      env: { ...process.env, IMPORT_RUN_STORE_DRIVER: driver },
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
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180_000);
