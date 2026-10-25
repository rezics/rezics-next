#!/usr/bin/env bun
/** Green verifies complete executable red outcomes, never product acceptance. */
import { MISSING_MEDIA_RESOLVER_DRIVER } from '../imports-media-resolver-driver.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-media-resolver.test.ts',
    'IMPORT_MEDIA_RESOLVER_DRIVER',
    MISSING_MEDIA_RESOLVER_DRIVER,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
