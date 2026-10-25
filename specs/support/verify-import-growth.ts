#!/usr/bin/env bun
/** Executable red specification only; a real production binding remains mandatory. */
import { fileURLToPath } from 'node:url';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-growth.test.ts', import.meta.url)),
    'IMPORT_GROWTH_DRIVER',
    'IMPORT_GROWTH_DRIVER is required: bind real import path counters',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
