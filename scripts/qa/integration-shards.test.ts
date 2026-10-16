import { expect, test } from 'bun:test';
import { isolatedIntegrationFiles } from './core.ts';
import { planIntegrationShards } from './integration-shards.ts';
import { integrationResourceClasses } from './resource-classes.ts';
import { commandOnlyIntegrationFiles, rawSparqlIntegrationFiles } from './isolated-integration-files.ts';
import { scaleIntegrationFiles } from './stack-environment.ts';

test('integration balances all files onto bounded reusable stacks and preserves fresh-state boundaries', () => {
  const rawFiles = rawSparqlIntegrationFiles();
  const dedicated = new Set([
    ...commandOnlyIntegrationFiles,
    ...integrationResourceClasses.keys(),
    ...scaleIntegrationFiles,
    'tests/qa/integration/g-854-large-library.test.ts',
    'tests/qa/integration/g-852-zones.test.ts',
    'tests/qa/integration/g-556-ranked-large.test.ts',
    'tests/qa/integration/g-939-discovery.test.ts',
  ]);
  const fresh = [...isolatedIntegrationFiles].filter((file) => !dedicated.has(file)).slice(0, 15);
  const estimates = new Map([
    ...Array.from({ length: 24 }, (_, index) => [`shared-${index}.test.ts`, 30_000] as const),
    ...fresh.map((file) => [file, 20_000] as const),
    ...[...dedicated].map((file) => [file, 40_000] as const),
  ]);
  const ownProject = (file: string) => commandOnlyIntegrationFiles.has(file) || integrationResourceClasses.has(file);
  const reusable = new Map([...estimates].filter(([file]) => !ownProject(file)));
  const assemblerGroups = [false, true]
    .map(raw => ({ raw, files: [...reusable.keys()].filter(file => rawFiles.has(file) === raw) }))
    .filter(group => group.files.length > 0);
  const reusableShardCount = assemblerGroups.reduce((sum, group) => sum + Math.min(6, group.files.length), 0);
  const persistent = [...estimates.keys()].filter(ownProject).sort();
  const plan = planIntegrationShards(estimates, 6);
  expect(plan).toHaveLength(reusableShardCount + persistent.length);
  expect(plan.flatMap((shard) => shard.files).sort()).toEqual([...estimates.keys()].sort());
  expect(planIntegrationShards(new Map([...estimates].reverse()), 6)).toEqual(plan);
  for (const shard of plan) {
    expect(new Set(shard.files.map(file => rawFiles.has(file))).size).toBe(1);
    expect(shard.batches.flat().sort()).toEqual(shard.files);
    for (const batch of shard.batches) {
      if (batch.some((file) => isolatedIntegrationFiles.has(file))) expect(batch).toHaveLength(1);
    }
  }
  const reusablePlan = plan.slice(0, reusableShardCount);
  expect(reusablePlan.flatMap(shard => shard.files).sort()).toEqual([...reusable.keys()].sort());
  for (const group of assemblerGroups) {
    const shards = reusablePlan.filter(shard => rawFiles.has(shard.files[0]!) === group.raw);
    expect(shards).toHaveLength(Math.min(6, group.files.length));
    const totals = shards.map(shard => shard.files.reduce((sum, file) => sum + estimates.get(file)!, 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(30_000);
  }
  expect(plan.slice(reusableShardCount)).toEqual(
    persistent
      .sort()
      .map((file) => ({
        files: [file],
        batches: [[file]],
        resourceClass: integrationResourceClasses.get(file) ?? 'ordinary',
      })),
  );
}, 60_000);
