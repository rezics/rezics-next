#!/usr/bin/env bun
/** Green verifies executable red identity specification, never production lifecycle proof. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MISSING_IMPORT_IDENTITY, openImportIdentity } from '../../services/kernel/test/imports/identity-fixture.ts';

// Only probe the composition stub's no-setup failure. No database/pool, account,
// policy or outcome is fabricated: accessing this unavailable input must fail.
await assert.rejects(
  () =>
    openImportIdentity({
      get database(): never {
        throw new Error('The composition stub must not open a database');
      },
      clock: () => new Date(),
    }),
  { name: 'Error', message: MISSING_IMPORT_IDENTITY },
);
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
