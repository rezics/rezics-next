import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const kernel = resolve(import.meta.dir, '../..');
const suite = resolve(kernel, '../../specs/search-relation-facets.test.ts');
const driver = resolve(import.meta.dir, 'outcome-driver.ts');

test('the relation facet outcome suite passes against the product with every test executed', async () => {
  const declared = readFileSync(suite, 'utf8').match(/^test\(/gm)?.length ?? 0;
  expect(declared).toBeGreaterThan(0);
  const child = Bun.spawn([process.execPath, 'test', suite], {
    cwd: kernel,
    env: { ...process.env, SEARCH_DRIVER: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  try {
    expect(code).toBe(0);
    expect(output).toMatch(new RegExp(`^\\s*${declared} pass$`, 'm'));
    expect(output).toMatch(/^\s*0 fail$/m);
    expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
  } catch (error) {
    console.error(output);
    throw error;
  }
}, 1_800_000);
