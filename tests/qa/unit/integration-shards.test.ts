import { expect, test } from 'bun:test';
import { planShards, stackPlanBudgetWarning } from '../../../scripts/qa/core.ts';
import {
  integrationBudgetSummary,
  integrationOverBudgetFiles,
  integrationPlanLimitMs,
  integrationProjectSchedule,
  integrationTierWallMs,
  planIntegrationShards,
} from '../../../scripts/qa/integration-shards.ts';
import { qaResourceClasses, queuedProjectsBudget } from '../../../scripts/qa/resource-classes.ts';

const ordinaryBudgetMs = qaResourceClasses.ordinary.budgetMs;
const planLimitMs = integrationPlanLimitMs(ordinaryBudgetMs);

// Case times from the loaded run that put these six files in one 480s project.
// erasure-release-proof's longer cases are the 20–30s proofs.
const compositionQualifierKey = 'tests/qa/integration/composition-qualifier-key.test.ts';
const erasureHeldReplayHttp = 'tests/qa/integration/erasure-held-replay-http.test.ts';
const erasureReleaseProof = 'tests/qa/integration/erasure-release-proof.test.ts';
const measured = new Map([
  [compositionQualifierKey, 56_558],
  [erasureHeldReplayHttp, 92_324],
  [erasureReleaseProof, [196, 10_674, 32_661, 25_460, 22_301, 23_688, 19_068, 19_406].reduce((sum, ms) => sum + ms, 0)],
  ['tests/qa/integration/feed-vote-concurrency.test.ts', 152 + 242 + 1_500 + 2_060 + 181],
  ['tests/qa/integration/g-630-zone-restore.test.ts', 5_211],
  ['tests/qa/integration/g-836-old-address.test.ts', 2_898],
]);

test('measured integration files plan into projects within 60% of the budget', () => {
  expect([...measured.values()].reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(planLimitMs);
  for (const slots of [1, 3]) {
    const plan = planIntegrationShards(measured, slots);
    expect(plan.flatMap((shard) => shard.files).sort()).toEqual([...measured.keys()].sort());
    for (const shard of plan) {
      const estimated = shard.files.reduce((sum, file) => sum + measured.get(file)!, 0);
      expect(estimated).toBeLessThanOrEqual(planLimitMs);
      expect(shard.resourceClass).toBe('ordinary');
    }
  }
  const queued = integrationProjectSchedule(planIntegrationShards(measured, 1), 1);
  expect(queued.length).toBeGreaterThan(1);
  expect(queued[0]!.queued).toBe(false);
  expect(queued.slice(1).every((project) => project.queued && project.deadlineMs === ordinaryBudgetMs)).toBe(true);
});

test('integration projects beyond three slots queue with their own deadlines', () => {
  const slots = 3;
  const estimates = new Map(Array.from({ length: 5 }, (_, index) => [`file-${index}.test.ts`, 200_000] as const));
  const plan = planIntegrationShards(estimates, slots);
  expect(plan.length).toBeGreaterThan(slots);
  for (const shard of plan) {
    const estimated = shard.files.reduce((sum, file) => sum + estimates.get(file)!, 0);
    expect(estimated).toBeLessThanOrEqual(planLimitMs);
  }
  const schedule = integrationProjectSchedule(plan, slots);
  expect(schedule.filter((project) => project.queued)).toHaveLength(plan.length - slots);
  expect(schedule.every((project) => project.deadlineMs === ordinaryBudgetMs)).toBe(true);
  const classes = plan.map((shard) => shard.resourceClass);
  expect(integrationTierWallMs(classes, slots, plan.length))
    .toBe(queuedProjectsBudget(classes.map((name) => qaResourceClasses[name].budgetMs), slots));
  expect(integrationTierWallMs(['large-tmpfs'], 1, 1)).toBe(qaResourceClasses['large-tmpfs'].budgetMs);
});

test('a file over 60% of the integration budget gets its own project and is named', () => {
  const file = 'tests/qa/integration/owner-cost.test.ts';
  const companion = 'tests/qa/integration/owner-small.test.ts';
  const estimates = new Map([[file, 300_000], [companion, 20_000]]);
  const plan = planIntegrationShards(estimates, 4);
  expect(plan.find((shard) => shard.files.includes(file))!.files).toEqual([file]);
  expect(plan.find((shard) => shard.files.includes(companion))!.files).toEqual([companion]);
  expect(integrationBudgetSummary(integrationOverBudgetFiles(estimates)))
    .toEqual([`- Over the integration budget: ${file}`]);

  const slow = 'tests/qa/integration/slow-owner.test.ts';
  const overTier = new Map([[slow, 500_000]]);
  const alone = planIntegrationShards(overTier, 1);
  expect(alone.map((shard) => shard.files)).toEqual([[slow]]);
  expect(integrationBudgetSummary(integrationOverBudgetFiles(overTier)))
    .toEqual([`- Over the integration budget: ${slow}`]);
  const wall = integrationTierWallMs(alone.map((shard) => shard.resourceClass), 1, alone.length);
  expect(wall).toBe(ordinaryBudgetMs);
  expect(stackPlanBudgetWarning(overTier, wall, 1, 6, 'integration',
    (count) => planIntegrationShards(overTier, count).map((shard) => shard.files)))
    .toContain('over its 480.0s budget');
});

test('estimates that already fit leave the integration plan unchanged', () => {
  const estimates = new Map([
    ['shared-a.test.ts', 120_000],
    ['shared-b.test.ts', 90_000],
    ['shared-c.test.ts', 40_000],
    ['shared-d.test.ts', 30_000],
  ]);
  expect([...estimates.values()].reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(planLimitMs);
  for (const slots of [1, 2, 4]) {
    const plan = planIntegrationShards(estimates, slots);
    expect(plan.map((shard) => shard.files)).toEqual(planShards(estimates, slots));
    expect(planIntegrationShards(new Map([...estimates].reverse()), slots)).toEqual(plan);
    expect(plan.every((shard) => shard.resourceClass === 'ordinary'
      && shard.batches.length === 1
      && shard.batches[0]!.join() === shard.files.join())).toBe(true);
    expect(integrationTierWallMs(plan.map((shard) => shard.resourceClass), slots, plan.length)).toBe(ordinaryBudgetMs);
    expect(integrationProjectSchedule(plan, slots).every((project) => !project.queued)).toBe(true);
  }
  expect(integrationOverBudgetFiles(estimates)).toEqual([]);
});
