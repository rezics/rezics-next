#!/usr/bin/env bun
/** Executability check only: missing-driver failures are never product acceptance. */
import { fileURLToPath } from 'node:url';

const sources = [
  ['bangumi', 'IMPORT_BANGUMI_DRIVER'],
  ['vndb', 'IMPORT_VNDB_DRIVER'],
  ['open-library', 'IMPORT_OPEN_LIBRARY_DRIVER'],
  ['wikidata', 'IMPORT_WIKIDATA_DRIVER'],
] as const;

const results: { source: string; code: number }[] = [];
for (const [source, variable] of sources) {
  const suite = fileURLToPath(new URL(`../imports-${source}.test.ts`, import.meta.url));
  const verifier = fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url));
  const child = Bun.spawn(
    [process.execPath, verifier, suite, variable, `${variable} is required: bind the production ${source} converter`],
    {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  results.push({ source, code: await child.exited });
}

if (results.length !== sources.length || results.some((result) => result.code !== 0)) {
  console.error('Import source specification verifier FAIL: all four source verifiers must pass.', results);
  process.exitCode = 1;
} else {
  console.log(
    'Import source specification verifier PASS: 4/4 source verifiers passed. Product acceptance remains RED without real drivers.',
  );
}
