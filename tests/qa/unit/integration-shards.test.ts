import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planShards, stackPlanBudgetWarning } from '../../../scripts/qa/core.ts';
import {
  integrationBudgetSummary,
  integrationOverBudgetFiles,
  integrationPlanLimitMs,
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
  expect(planIntegrationShards(measured, 1).length).toBeGreaterThan(1);
});

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

const queueFiles = [
  'tests/qa/integration/access-download-api.test.ts',
  'tests/qa/integration/also-enjoyed.test.ts',
  'tests/qa/integration/credit-creation.test.ts',
  'tests/qa/integration/feed-vote-concurrency.test.ts',
  'tests/qa/integration/g-836-old-address.test.ts',
];

test('queued integration projects keep the command budget and start as slots free', async () => {
  const slots = 3;
  const root = join(import.meta.dir, '../../..');
  const artifactRoot = mkdtempSync(join(root, '.temp', 'integration-queue-'));
  // History lives under this test's own artifact root, never the shared .artifacts/qa other runs read.
  const history = join(artifactRoot, '20990101t000000-a16090');
  const slotDirectory = join(artifactRoot, 'slots');
  mkdirSync(join(history, 'logs'), { recursive: true });
  mkdirSync(slotDirectory);
  writeFileSync(join(history, 'logs', 'integration-1.log'), '');
  writeFileSync(join(history, 'logs', 'integration-1-durations.json'), JSON.stringify(
    Object.fromEntries(queueFiles.map((file) => [file, 200_000])),
  ));
  const previousArgv = process.argv;
  const previousEnv = {
    GOAL_QA_SLOTS: process.env.GOAL_QA_SLOTS,
    GOAL_QA_SLOT_DIRECTORY: process.env.GOAL_QA_SLOT_DIRECTORY,
    GOAL_QA_HEAVY_RUN: process.env.GOAL_QA_HEAVY_RUN,
    REZICS_QA_ARTIFACT_ROOT: process.env.REZICS_QA_ARTIFACT_ROOT,
    REZICS_QA_MEMORY_DEADLINE: process.env.REZICS_QA_MEMORY_DEADLINE,
    REZICS_STACK_PROFILE: process.env.REZICS_STACK_PROFILE,
    REZICS_QA_MEMORY_EVENTS: process.env.REZICS_QA_MEMORY_EVENTS,
    GOAL_QA_WAIT_DIR: process.env.GOAL_QA_WAIT_DIR,
    GOAL_QA_COMMAND: process.env.GOAL_QA_COMMAND,
  };
  process.argv = ['bun', 'scripts/qa/cli.ts', '--tier', 'integration', ...queueFiles.flatMap((file) => ['--file', file])];
  process.env.GOAL_QA_SLOTS = String(slots);
  process.env.GOAL_QA_SLOT_DIRECTORY = slotDirectory;
  delete process.env.GOAL_QA_HEAVY_RUN;
  process.env.REZICS_QA_ARTIFACT_ROOT = artifactRoot;
  const started: { files: string[]; budget: number }[] = [];
  const releases: (() => void)[] = [];
  let running = 0;
  const restoreEnv = () => {
    process.argv = previousArgv;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const { runStackTier } = await import('../../../scripts/qa/cli.ts');
    const done = runStackTier('integration', async (_tier, projectRunId, files, _flags, budget) => {
      running++;
      started.push({ files: [...files], budget });
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return {
        ok: true, timedOut: false, noMatch: false,
        record: { project: projectRunId, files, status: 'passed', stage: 'test', elapsedMs: 1 },
      };
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
  } finally {
    restoreEnv();
    rmSync(history, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
