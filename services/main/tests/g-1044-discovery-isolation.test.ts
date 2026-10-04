import { expect, test } from 'bun:test';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';

const discovery = ['g-1016-discovery-refresh', 'g-1029-discovery-ready', 'g-1033-discovery-refresh']
  .map(name => `tests/qa/integration/${name}.test.ts`);

test('G1044: discovery owns a reset batch after ten shared files and keeps every file in the plan', () => {
  const prior = ['g-591-contribution-basis', 'g-629-entity-page', 'g-629-statement-context',
    'g-630-zone-restore', 'g-630-zone-routes', 'g-650-resource-targets', 'g-652-target-reviews',
    'g-653-types', 'g-657-zone-facets', 'g-693-wiki-delta']
    .map(name => `tests/qa/integration/${name}.test.ts`);
  const plans = planIntegrationShards(new Map([...prior, ...discovery].map(file => [file, 1000])), 1);
  expect(plans).toHaveLength(1);
  expect(plans[0]!.batches[0]).toEqual(prior.sort());
  expect(plans[0]!.batches.slice(1).map(batch => batch[0]).sort()).toEqual(discovery.sort());
  expect(plans[0]!.batches.slice(1).every(batch => batch.length === 1)).toBe(true);
  expect(plans[0]!.files.sort()).toEqual([...prior, ...discovery].sort());
});
