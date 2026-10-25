#!/usr/bin/env bun
/** Executability check only: missing-driver failures are never product acceptance. */
import { fileURLToPath } from 'node:url';

const sources = [
  ['bangumi', 'IMPORT_BANGUMI_DRIVER'],
  ['vndb', 'IMPORT_VNDB_DRIVER'],
  ['open-library', 'IMPORT_OPEN_LIBRARY_DRIVER'],
  ['wikidata', 'IMPORT_WIKIDATA_DRIVER'],
] as const;

let failed = false;
for (const [source, variable] of sources) {
  const suite = fileURLToPath(new URL(`../imports-${source}.test.ts`, import.meta.url));
  const verifier = fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url));
  const child = Bun.spawn([
    process.execPath,
    verifier,
    suite,
    variable,
    `${variable} is required: bind the production ${source} converter`,
  ], {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (await child.exited !== 0) failed = true;
}

if (failed) {
  console.error('Import source specification verifier FAIL: all four source verifiers must pass.');
  process.exitCode = 1;
} else {
  console.log('Import source specification verifier PASS. Product acceptance remains RED without real drivers.');
}
