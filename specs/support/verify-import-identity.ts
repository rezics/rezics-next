#!/usr/bin/env bun
/**
 * This command proves specification executability only. Product acceptance comes
 * from the separately dispatched frozen identity-outcomes wrapper with the actual
 * native driver.
 */
import { fileURLToPath } from 'node:url';
import { MISSING_IMPORT_IDENTITY } from '../../services/kernel/test/imports/identity-fixture.ts';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-identity.test.ts', import.meta.url)),
    'IMPORT_IDENTITY_DRIVER',
    MISSING_IMPORT_IDENTITY,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
