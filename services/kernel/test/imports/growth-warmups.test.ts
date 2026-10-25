import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Until the growth harness refuses warmups < 1 itself, keep imports' growth checks warm.
test('imports growth checks measure every scale warm', () => {
  const directory = resolve(import.meta.dir);
  const cold = readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => /\bwarmups\s*:\s*0\b/.test(readFileSync(resolve(directory, name), 'utf8')));
  expect(cold).toEqual([]);
});
