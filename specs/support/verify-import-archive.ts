#!/usr/bin/env bun
/** Green proves every archive outcome executes red without its production binding. */
import { fileURLToPath } from 'node:url';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-archive.test.ts', import.meta.url)),
    'IMPORT_ARCHIVE_DRIVER',
    'IMPORT_ARCHIVE_DRIVER is required: bind the production streaming TAR reader',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', cwd: fileURLToPath(new URL('../../', import.meta.url)) },
);
process.exitCode = await child.exited;
