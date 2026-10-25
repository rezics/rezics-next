#!/usr/bin/env bun
/** Green means every transport specification executes red without implementation. */
import { fileURLToPath } from 'node:url';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-transport.test.ts', import.meta.url)),
    'IMPORT_TRANSPORT_DRIVER',
    'IMPORT_TRANSPORT_DRIVER is required: bind the production importer public transport',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', cwd: fileURLToPath(new URL('../../', import.meta.url)) },
);
process.exitCode = await child.exited;
