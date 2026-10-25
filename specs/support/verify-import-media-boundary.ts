#!/usr/bin/env bun
/** Green means every executable outcome is red for the stable missing fixture. */
import { MISSING_MEDIA_BOUNDARY } from '../../services/kernel/test/imports/media-boundary.ts';

const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-media-boundary.test.ts',
    'IMPORT_MEDIA_BOUNDARY_DRIVER',
    MISSING_MEDIA_BOUNDARY,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
