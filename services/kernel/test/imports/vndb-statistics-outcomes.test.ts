import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('all six frozen VNDB archive statistic outcomes pass through native Auth and public HTTP', async () => {
  const suite = resolve(import.meta.dir, '../../../../specs/imports-vndb-statistics.test.ts');
  const driver = resolve(import.meta.dir, 'vndb-statistics-driver.ts');
  expect(readFileSync(suite, 'utf8').match(/^test\(/gm)?.length).toBe(6);
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '120000', suite], {
    env: { ...process.env, IMPORT_VNDB_STATISTICS_DRIVER: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  console.log(output);
  expect(code).toBe(0);
  expect(output).toMatch(/^\s*6 pass$/m);
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 600_000);
