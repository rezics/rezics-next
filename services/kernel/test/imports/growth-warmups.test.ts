import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep explicit cold overrides out of imports' growth journeys.
test('imports growth checks measure every scale warm', () => {
  const directory = resolve(import.meta.dir);
  const cold = readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => /\bwarmups\s*:\s*0\b/.test(readFileSync(resolve(directory, name), 'utf8')));
  expect(cold).toEqual([]);
});

test('imports growth warmup includes native concurrent fence reads and authority checks', async () => {
  const child = Bun.spawn([process.execPath, 'test', resolve(import.meta.dir, 'api-warmup.test.ts')], {
    env: process.env,
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
  expect(output).toMatch(/^\s*1 pass$/m);
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 600_000);
