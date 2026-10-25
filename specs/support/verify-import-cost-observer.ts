#!/usr/bin/env bun
/** Green proves all specification outcomes run red; never actual cost evidence. */
import { MISSING_COST_OBSERVER_DRIVER } from '../imports-cost-observer-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-cost-observer.test.ts',
    'IMPORT_COST_OBSERVER_DRIVER',
    MISSING_COST_OBSERVER_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
