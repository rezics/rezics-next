import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('all real imported media boundary outcomes pass', async () => {
  const suite = resolve(import.meta.dir, '../../../../specs/imports-media-boundary.test.ts');
  const driver = resolve(import.meta.dir, 'media-boundary-driver.ts');
  const count = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(count).toBeGreaterThan(0);
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '120000', suite], {
    env: { ...process.env, IMPORT_MEDIA_BOUNDARY_DRIVER: driver },
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
}, 600_000);
