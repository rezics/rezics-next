#!/usr/bin/env bun
/** Green means every bounded-reader outcome executes red without a binding. */
import { MISSING_READER_BOUNDS_DRIVER } from '../imports-reader-bounds-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-reader-bounds.test.ts',
    'IMPORT_READER_BOUNDS_DRIVER',
    MISSING_READER_BOUNDS_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
