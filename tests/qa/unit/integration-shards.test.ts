import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { planShards, planStackProjects, selfManagedFaultAdmission, serialRestoreDrillFiles, stackPlanBudgetWarning } from '../../../scripts/qa/core.ts';
import { restoreDrillSchedule } from '../../../scripts/qa/preparation-selection.ts';
import { independentRestorePreparationOptions, ownerErasurePreparationOptions } from '../../../scripts/qa/retained-source.ts';
import {
  integrationBudgetSummary,
  integrationOverBudgetFiles,
  integrationPlanLimitMs,
  integrationStackPoolEligible,
  integrationTierWallMs,
  planIntegrationShards,
  runQueuedProjects,
} from '../../../scripts/qa/integration-shards.ts';
import { qaResourceClasses, queuedProjectsBudget } from '../../../scripts/qa/resource-classes.ts';

const ordinaryBudgetMs = qaResourceClasses.ordinary.budgetMs;
const planLimitMs = integrationPlanLimitMs(ordinaryBudgetMs);

test('restore registration names executable files and selects singleton consumers in declared order', () => {
  const root = resolve(import.meta.dir, '../../..');
  expect(new Set(serialRestoreDrillFiles).size).toBe(serialRestoreDrillFiles.length);
  for (const file of serialRestoreDrillFiles) expect(existsSync(resolve(root, file))).toBe(true);
  for (const name of readdirSync(resolve(root, 'tests/qa/fault-recovery'))) {
    const file = `tests/qa/fault-recovery/${name}`;
    if (ownerErasurePreparationOptions(file) || independentRestorePreparationOptions(file))
      expect(serialRestoreDrillFiles as readonly string[]).toContain(file);
  }
  const ordinary = ['tests/qa/fault-recovery/ordinary-a.test.ts', 'tests/qa/fault-recovery/ordinary-b.test.ts'];
  // Reverse duration order so the plan cannot accidentally rely on longest-first packing.
  const estimates = new Map([...serialRestoreDrillFiles, ...ordinary].map((file, index) => [file, index + 1]));
  for (const slots of [1, 3, 6]) {
    const schedule = restoreDrillSchedule(planStackProjects(estimates, slots, 'fault/recovery'), serialRestoreDrillFiles);
    expect(schedule.serial).toEqual(serialRestoreDrillFiles.map(file => [file]));
    expect(schedule.parallel.flat().sort()).toEqual([...ordinary].sort());
    expect([...schedule.parallel, ...schedule.serial].flat().sort()).toEqual([...estimates.keys()].sort());
  }
  const partial = [serialRestoreDrillFiles[3], serialRestoreDrillFiles[0]];
  expect(restoreDrillSchedule([partial], serialRestoreDrillFiles)).toEqual({
    parallel: [], serial: [[serialRestoreDrillFiles[0]], [serialRestoreDrillFiles[3]]],
  });
});

test('all three independent artifact-only targets are serial self-managed host-admitted consumers', () => {
  const targets = ['independent-restore', 'independent-restore-authority', 'independent-restore-refusals']
    .map(name => `tests/qa/fault-recovery/${name}.test.ts`);
  expect(targets.map(independentRestorePreparationOptions)).toEqual([
    { withRecipe: true }, { withRecipe: false }, { withRecipe: false },
  ]);
  expect(independentRestorePreparationOptions('tests/qa/fault-recovery/independent-restore-support.ts')).toBeUndefined();
  for (const file of targets) {
    expect(serialRestoreDrillFiles as readonly string[]).toContain(file);
    expect(selfManagedFaultAdmission.get(file)).toBe('host');
  }
  expect(restoreDrillSchedule(planStackProjects(new Map(targets.map(file => [file, 1])), 3, 'fault/recovery'),
    serialRestoreDrillFiles)).toEqual({ parallel: [], serial: targets.map(file => [file]) });
});

test('existing queue consumes scheduled restores one at a time with a fresh unchanged command budget', async () => {
  const schedule = restoreDrillSchedule([[...serialRestoreDrillFiles].reverse()], serialRestoreDrillFiles);
  const starts: string[] = [];
  let active = 0;
  const results = await runQueuedProjects(schedule.serial, 1, 360_000, async (index, files, budget) => {
    expect(active++).toBe(0);
    starts.push(files[0]!);
    expect(index).toBe(starts.length - 1);
    expect(budget).toBe(360_000);
    await Promise.resolve();
    active--;
    return files[0];
  });
  expect(starts).toEqual([...serialRestoreDrillFiles]);
  expect(results).toEqual(starts);
});

test('only shared ordinary integration stacks enter the warm pool', () => {
  const files = ['tests/qa/integration/shared-stack.test.ts'];
  expect(integrationStackPoolEligible({ tier: 'integration', files })).toBe(true);
  for (const input of [
    { tier: 'integration', files, keep: true },
    { tier: 'integration', files, backend: true },
    { tier: 'integration', files, persistent: true },
    { tier: 'e2e', files },
    { tier: 'fault/recovery', files },
    { tier: 'integration', files: [] },
    { tier: 'integration', files: ['services/main/tests/edit.integration.test.ts'] },
    { tier: 'integration', files: ['tests/qa/integration/g-1038-catalogue-scale.test.ts'] },
    { tier: 'integration', files: ['tests/qa/integration/event-query-bounds.test.ts'] },
  ]) expect(integrationStackPoolEligible(input)).toBe(false);
});

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

// This first plan also discovers raw-SPARQL assemblers across the fixed repository
// inventory. Its cold crawl measured 18.75s with every processor loaded; allow
// 60s for that one-time bounded preparation, independently of planner size.
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
  expect(planIntegrationShards(measured, 1).length).toBeGreaterThan(1);
}, 60_000);

test('integration files that need more projects than three slots stay within 60% of the budget', () => {
  const slots = 3;
  const estimates = new Map(Array.from({ length: 5 }, (_, index) => [`file-${index}.test.ts`, 200_000] as const));
  const plan = planIntegrationShards(estimates, slots);
  expect(plan.length).toBeGreaterThan(slots);
  for (const shard of plan) {
    const estimated = shard.files.reduce((sum, file) => sum + estimates.get(file)!, 0);
    expect(estimated).toBeLessThanOrEqual(planLimitMs);
  }
  const classes = plan.map((shard) => shard.resourceClass);
  expect(integrationTierWallMs(classes, slots, plan.length))
    .toBe(queuedProjectsBudget(classes.map((name) => qaResourceClasses[name].budgetMs), slots));
  expect(integrationTierWallMs(['large-tmpfs'], 1, 1)).toBe(qaResourceClasses['large-tmpfs'].budgetMs);
});

for (const size of [256, 512]) {
  test(`integration planning visits estimates linearly for ${size} files that each need a project`, () => {
    let reads = 0;
    class CountedEstimates extends Map<string, number> {
      override get(file: string): number | undefined { reads++; return super.get(file); }
    }
    const estimates = new CountedEstimates(Array.from({ length: size },
      (_, index) => [`shared-${index}.test.ts`, 200_000] as const));
    const plan = planIntegrationShards(estimates, 1);
    expect(plan).toHaveLength(size);
    expect(plan.flatMap(shard => shard.files).sort()).toEqual([...estimates.keys()].sort());
    expect(plan.every(shard => shard.files.length === 1 && shard.resourceClass === 'ordinary')).toBe(true);
    // Count work rather than CPU scheduling time: rebuilding each width is quadratic here.
    expect(reads).toBeLessThanOrEqual(4 * size);
  });
}

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
  }
  expect(integrationOverBudgetFiles(estimates)).toEqual([]);
});

test('the membership-proof probe runs alone while ordinary Recipe files share a batch', () => {
  const probe = 'tests/qa/integration/g-829-public-reads.test.ts';
  const ordinaryFiles = [
    'tests/qa/integration/realm-submission-api.test.ts',
    'tests/qa/integration/recipe-update.test.ts',
    'tests/qa/integration/recipe-work-page.test.ts',
  ];
  const files = [probe, ...ordinaryFiles];
  const estimates = new Map(files.map((file) => [file, 10] as const));

  const projects = planStackProjects(estimates, 1, 'integration');
  expect(projects.find((project) => project.includes(probe))).toEqual([probe]);
  expect(projects.find((project) => ordinaryFiles.every((file) => project.includes(file)))?.length)
    .toBe(ordinaryFiles.length);
  expect(projects.flat().sort()).toEqual([...files].sort());

  const batches = planIntegrationShards(estimates, 1).flatMap((shard) => shard.batches);
  expect(batches.find((batch) => batch.includes(probe))).toEqual([probe]);
  expect(batches.find((batch) => ordinaryFiles.every((file) => batch.includes(file)))?.length)
    .toBe(ordinaryFiles.length);
});

const queueFiles = [
  'tests/qa/integration/access-download-api.test.ts',
  'tests/qa/integration/also-enjoyed.test.ts',
  'tests/qa/integration/credit-creation.test.ts',
  'tests/qa/integration/feed-vote-concurrency.test.ts',
  'tests/qa/integration/g-836-old-address.test.ts',
];

test('queued integration projects keep the command budget and start as slots free', async () => {
  const slots = 3;
  const estimates = new Map(queueFiles.map((file) => [file, 200_000]));
  const plan = planIntegrationShards(estimates, slots);
  expect(plan.length).toBeGreaterThan(slots);
  const started: { files: string[]; budget: number }[] = [];
  const releases: (() => void)[] = [];
  let running = 0;
  // scripts/qa/cli.ts queues stack projects through this function.
  const done = runQueuedProjects(plan, slots, ordinaryBudgetMs, async (_index, project, budget) => {
    running++;
    started.push({ files: [...project.files], budget });
    await new Promise<void>((resolve) => releases.push(resolve));
    running--;
  });
  const untilStarted = async (count: number) => {
    const deadline = Date.now() + 5_000;
    while (started.length < count) {
      if (Date.now() >= deadline) throw new Error(`runner started ${started.length} projects`);
      await Bun.sleep(5);
    }
  };
  try {
    await untilStarted(slots);
    expect(started).toHaveLength(slots);
    expect(running).toBe(slots);
    await Bun.sleep(30);
    expect(started).toHaveLength(slots);
    const runningFiles = new Set(started.flatMap((project) => project.files));
    releases.shift()!();
    await untilStarted(slots + 1);
    expect(started).toHaveLength(slots + 1);
    expect(running).toBe(slots);
    expect(runningFiles.has(started[slots]!.files[0]!)).toBe(false);
    expect(started.every((project) => project.files.length === 1 && project.budget === ordinaryBudgetMs)).toBe(true);
  } finally {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = releases.splice(0);
      for (const release of waiting) release();
      if (running === 0 && releases.length === 0 && started.length >= slots + 1) break;
      await Bun.sleep(5);
    }
    await done;
  }
});
