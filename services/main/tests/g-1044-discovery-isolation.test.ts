import { expect, test } from 'bun:test';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';
import { isolatedIntegrationFileList, rawSparqlIntegrationFiles } from '../../../scripts/qa/isolated-integration-files.ts';

const discovery = ['g-1016-discovery-refresh', 'g-1029-discovery-ready', 'g-1033-discovery-refresh']
  .map(name => `tests/qa/integration/${name}.test.ts`);

test('G1044: discovery owns a reset batch after ten shared files and keeps every file in the plan', () => {
  const prior = ['g-591-contribution-basis', 'g-629-entity-page', 'g-629-statement-context',
    'g-630-zone-restore', 'g-630-zone-routes', 'g-650-resource-targets', 'g-652-target-reviews',
    'g-653-types', 'g-657-zone-facets', 'g-744-findings']
    .map(name => `tests/qa/integration/${name}.test.ts`);
  const files = [...prior, ...discovery];
  const rawFiles = rawSparqlIntegrationFiles();
  const isolatedFiles = new Set(isolatedIntegrationFileList);
  const plans = planIntegrationShards(new Map(files.map(file => [file, 1000])), 1);
  const assemblerClasses = new Set(files.map(file => rawFiles.has(file)));

  expect(prior.every(file => !isolatedFiles.has(file))).toBe(true);
  expect(discovery.every(file => isolatedFiles.has(file))).toBe(true);
  expect(plans).toHaveLength(assemblerClasses.size);
  expect(plans.flatMap(plan => plan.files).sort()).toEqual([...files].sort());
  for (const plan of plans) {
    expect(new Set(plan.files.map(file => rawFiles.has(file))).size).toBe(1);
    const shared = plan.files.filter(file => !isolatedFiles.has(file)).sort();
    const isolated = plan.files.filter(file => isolatedFiles.has(file)).sort();
    expect(plan.batches).toEqual([
      ...(shared.length ? [shared] : []),
      ...isolated.map(file => [file]),
    ]);
  }
  const batches = plans.flatMap(plan => plan.batches);
  const priorBatches = batches.filter(batch => batch.some(file => prior.includes(file)));
  const discoveryBatches = batches.filter(batch => batch.some(file => discovery.includes(file)));
  expect(priorBatches.flat().sort()).toEqual(prior.sort());
  expect(priorBatches.every(batch => batch.every(file => prior.includes(file)))).toBe(true);
  expect(discoveryBatches.map(batch => batch[0]).sort()).toEqual(discovery.sort());
  expect(discoveryBatches.every(batch => batch.length === 1)).toBe(true);
});
