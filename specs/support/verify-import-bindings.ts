#!/usr/bin/env bun
/** Green verifies executable red specification, never product acceptance. */
import { MISSING_BINDINGS_DRIVER } from '../imports-bindings-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-bindings.test.ts',
    'IMPORT_BINDINGS_DRIVER',
    MISSING_BINDINGS_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
