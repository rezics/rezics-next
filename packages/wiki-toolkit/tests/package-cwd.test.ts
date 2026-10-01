// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('G-848: parser and distribution tests also pass with the package as the working directory', () => {
  const child = spawnSync(
    'bun',
    ['test', './tests/parsers.test.ts', './tests/package.test.ts', './tests/txt-streaming.test.ts'],
    {
      cwd: resolve(import.meta.dir, '..'),
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
  if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  expect(child.status).toBe(0);
}, 100_000);
