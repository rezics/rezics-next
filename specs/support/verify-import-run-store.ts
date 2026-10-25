#!/usr/bin/env bun
/** A green verifier proves every scenario is executable red, not product success. */
import { MISSING_RUN_STORE_DRIVER } from '../imports-run-store-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-run-store.test.ts',
    'IMPORT_RUN_STORE_DRIVER',
    MISSING_RUN_STORE_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
