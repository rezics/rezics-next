import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('the unchanged bangumi source outcomes pass with the production converter', async () => {
  const suite = resolve(import.meta.dir, '../../../specs/imports-bangumi.test.ts');
  const driver = resolve(import.meta.dir, 'bangumi-driver.ts');
  const names = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(names).toBeGreaterThan(0);
  const binding = fileURLToPath(new URL('./bangumi-outcomes-binding.ts', import.meta.url));
  const child = Bun.spawn([process.execPath, 'test', '--preload', binding, '--timeout', '30000', suite], {
    cwd: resolve(import.meta.dir, '../../..'),
    env: { ...process.env, IMPORT_BANGUMI_DRIVER: driver },
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
  expect(output).toMatch(new RegExp(`^\\s*${names} pass$`, 'm'));
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 120_000);
