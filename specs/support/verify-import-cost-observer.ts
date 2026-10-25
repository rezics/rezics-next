#!/usr/bin/env bun
/** Run the actual pure converter tests; propagate failures directly. */
export {};
const child = Bun.spawn(
  [
    process.execPath,
    'test',
    'packages/conversion/tests/logical-growth.test.ts',
    'packages/conversion/tests/bangumi-growth.test.ts',
    'packages/conversion/tests/vndb-growth.test.ts',
    'packages/conversion/tests/open-library-growth.test.ts',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
