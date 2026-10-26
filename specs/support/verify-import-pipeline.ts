#!/usr/bin/env bun
/** Green proves importer pipeline outcomes are executable red behind a typed missing driver. */
import { MISSING_PIPELINE_DRIVER } from '../imports-pipeline-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-pipeline.test.ts',
    'IMPORT_PIPELINE_DRIVER',
    MISSING_PIPELINE_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
