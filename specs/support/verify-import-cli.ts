#!/usr/bin/env bun
/** Executable RED proof only; no production binding is installed or simulated. */
const child = Bun.spawn(
  [
    process.execPath,
    'specs/support/verify-outcome-suite.ts',
    'specs/imports-cli.test.ts',
    'IMPORT_CLI_DRIVER',
    'IMPORT_CLI_DRIVER is required: bind production importer CLI and runner',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
export {};
