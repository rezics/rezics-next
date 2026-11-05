import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const kernel = resolve(import.meta.dir, '../..');
const suite = resolve(kernel, '../../specs/semantic-outcomes.test.ts');
const driver = resolve(import.meta.dir, 'outcome-binding.ts');

test('the original semantic outcome suite passes against the product with every test executed', async () => {
  const declared = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(declared).toBeGreaterThan(0);
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '120000', suite], {
    cwd: kernel,
    env: { ...process.env, SEMANTIC_DRIVER: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  if (code !== 0) console.error(output);
  else console.log(output);
  expect(code).toBe(0);
  expect(output).toMatch(new RegExp(`^\\s*${declared} pass$`, 'm'));
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 900_000);
