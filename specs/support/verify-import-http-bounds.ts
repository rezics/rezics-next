#!/usr/bin/env bun
/** Green proves a complete executable red specification, never product acceptance. */
import { fileURLToPath } from 'node:url';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-http-bounds.test.ts', import.meta.url)),
    'IMPORT_HTTP_BOUNDS_DRIVER',
    'IMPORT_HTTP_BOUNDS_DRIVER is required: instrument real createImportFetch operations',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', cwd: fileURLToPath(new URL('../../', import.meta.url)) },
);
process.exitCode = await child.exited;
