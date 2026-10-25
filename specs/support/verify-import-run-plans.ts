#!/usr/bin/env bun
/** Green proves every declared outcome executes red without a production binding. */
import { MISSING_RUN_PLANS_DRIVER } from '../imports-run-plans-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-run-plans.test.ts',
    'IMPORT_RUN_PLANS_DRIVER',
    MISSING_RUN_PLANS_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
