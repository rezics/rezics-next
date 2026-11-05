import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('all durable cover outcomes pass with production resolver', async () => {
  const suite = resolve(import.meta.dir, '../../../specs/imports-media-resolver.test.ts');
  // Import resolves this module-relative path from the placed spec checkout.
  const driver = '../services/importer/tests/media-resolver-driver.ts';
  const count = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(count).toBeGreaterThan(0);
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', suite], {
    env: { ...process.env, IMPORT_MEDIA_RESOLVER_DRIVER: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  if (code !== 0) console.error(output);
  expect(code).toBe(0);
  expect(output).toMatch(new RegExp(`^\\s*${count} pass$`, 'm'));
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 120_000);
