#!/usr/bin/env bun
/** Missing-driver execution proof only; real importer/API acceptance remains separate. */
const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-ledger.test.ts',
    'IMPORT_LEDGER_DRIVER',
    'IMPORT_LEDGER_DRIVER is required: bind production import state reconciliation',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;

export {};
