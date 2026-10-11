import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planIntegrationShards } from './integration-shards.ts';
import { integrationStackAdmitsWorkScope } from './stack-environment.ts';
import { rawSparqlIntegrationFiles, rawSparqlIntegrationScan, scanRawSparqlIntegrationFiles } from './isolated-integration-files.ts';

test('raw SPARQL scan covers integration roots and follows imported support helpers', () => {
  expect(rawSparqlIntegrationScan.roots).toContain('services/main/tests/work-read.integration.test.ts');
  expect(rawSparqlIntegrationScan.files.has('tests/qa/integration/g-506-target.test.ts')).toBe(true);
  expect(rawSparqlIntegrationFiles.has('tests/qa/integration/podcast-playlist.test.ts')).toBe(true);
  expect(rawSparqlIntegrationFiles.has('tests/qa/integration/model-generation-refusal.test.ts')).toBe(true);
  expect(rawSparqlIntegrationScan.sites.get('tests/qa/integration/g-1011-optional-work-reads.test.ts'))
    .toContain('tests/qa/integration/discovery-rating-context-fixture.ts:10: fuseki.update()');
  expect(rawSparqlIntegrationScan.sites.get('tests/qa/integration/membership-seek.test.ts')
    ?.some(site => site.includes('raw /update request'))).toBe(true);
  expect(rawSparqlIntegrationFiles.has('tests/qa/integration/validation-product-ingress.test.ts')).toBe(false);
});

test('integration shards keep fixture and product assembler files apart', () => {
  const raw = 'tests/qa/integration/g-506-target.test.ts';
  const product = 'tests/qa/integration/release.test.ts';
  const shards = planIntegrationShards(new Map([[raw, 1], [product, 1]]), 1);

  expect(shards).toHaveLength(2);
  expect(shards.every(shard => shard.files.every(file => rawSparqlIntegrationFiles.has(file))
    || shard.files.every(file => !rawSparqlIntegrationFiles.has(file)))).toBe(true);
  expect(integrationStackAdmitsWorkScope([raw], false)).toBe(false);
  expect(integrationStackAdmitsWorkScope([product], false)).toBe(true);
  expect(() => integrationStackAdmitsWorkScope([raw, product], false)).toThrow(/mixes raw-SPARQL/);
});

test('raw SPARQL scan reports an unresolved helper at its import site', () => {
  const root = resolve(import.meta.dir, '../..');
  const directory = mkdtempSync(join(root, '.temp', 'qa-raw-update-scan-'));
  const integrationDirectory = join(directory, 'tests', 'qa', 'integration');
  mkdirSync(integrationDirectory, { recursive: true });
  writeFileSync(join(integrationDirectory, 'unresolved-helper.test.ts'), "import './missing-support.ts';\n");

  try {
    expect(() => scanRawSparqlIntegrationFiles(directory))
      .toThrow(/unresolved-helper\.test\.ts:1: \.\/missing-support\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('raw SPARQL scan maps HTTP update helpers to the importing integration test', () => {
  const root = resolve(import.meta.dir, '../..');
  const directory = mkdtempSync(join(root, '.temp', 'qa-raw-http-scan-'));
  const integrationDirectory = join(directory, 'tests', 'qa', 'integration');
  mkdirSync(integrationDirectory, { recursive: true });
  writeFileSync(join(integrationDirectory, 'http-update.test.ts'), "import { sendUpdate } from './http-update-support.ts';\nvoid sendUpdate;\n");
  writeFileSync(join(integrationDirectory, 'http-update-support.ts'), `export function sendUpdate(url: string) {
  return fetch(\`${'${url}'}/update\`, { method: 'POST', headers: { 'content-type': 'application/sparql-update' },
    body: 'INSERT DATA {}' });
}\n`);

  try {
    const scan = scanRawSparqlIntegrationFiles(directory);
    expect(scan.files.has('tests/qa/integration/http-update.test.ts')).toBe(true);
    expect(scan.sites.get('tests/qa/integration/http-update.test.ts')
      ?.some(site => site.includes('http-update-support.ts:2: raw /update request'))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
