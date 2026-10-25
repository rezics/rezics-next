#!/usr/bin/env bun
/** Missing-driver evidence for the normalized raw-table specification only. */
import { fileURLToPath } from 'node:url';

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
    fileURLToPath(new URL('../imports-vndb-tables.test.ts', import.meta.url)),
    'IMPORT_VNDB_TABLES_DRIVER',
    'IMPORT_VNDB_TABLES_DRIVER is required: bind real VNDB table ingestion',
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
