import { expect, test } from 'bun:test';
import { SEED_AXES, seedCheckpointPlan } from '../support/seed-checkpoint-plan.ts';
import { WORK_PROFILE_DIMENSIONS, workProfileDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import { seedCustodyCuts } from '../../../scripts/qa/seed-preflight.ts';
import type { RetainedSeed, RetainedSeedCut } from '../support/seed-checkpoints.ts';

test('each retained series grows exactly one axis while all other populations stay fixed', () => {
  const plan = seedCheckpointPlan();
  expect(plan).toHaveLength(SEED_AXES.length * 3);
  for (const axis of SEED_AXES) {
    const series = plan.filter(stage => stage.axis === axis)
      .map(stage => workProfileDimensions(axis, stage.scale, stage.fixed));
    expect(series.map(dimensions => dimensions[axis]))
      .toEqual(axis === 'recipeOccurrences' ? [100, 400, 1600] : [4, 16, 64]);
    for (const other of WORK_PROFILE_DIMENSIONS.filter(candidate => candidate !== axis))
      expect(new Set(series.map(dimensions => dimensions[other])).size).toBe(1);
  }
  for (let index = 3; index < plan.length; index += 3) {
    const previous = plan[index - 1]!, next = plan[index]!;
    expect(workProfileDimensions(next.axis, next.scale, next.fixed))
      .toEqual(workProfileDimensions(previous.axis, previous.scale, previous.fixed));
  }
});

test('retained custody covers all six series and refuses missing, mixed or substituted cuts', () => {
  const axes = Object.fromEntries(SEED_AXES.map(axis => [axis, seedCheckpointPlan()
    .filter(stage => stage.axis === axis).map(stage => ({
      manifest: { id: `${axis}/${stage.scale}`, dimension: axis, scale: stage.scale },
    }))])) as RetainedSeed['axes'];
  const seed = { format: 'seed-checkpoints-v3', sourceRunId: 'fixture', actor: 'fixture',
    cuts: axes.unrelatedWorks, axes } satisfies RetainedSeed;
  expect(seedCustodyCuts(seed).map(cut => cut.manifest.id))
    .toEqual(seedCheckpointPlan().map(stage => `${stage.axis}/${stage.scale}`));
  const missing = structuredClone(seed);
  missing.axes.recipeOccurrences.pop();
  expect(() => seedCustodyCuts(missing)).toThrow('incomplete');
  const mixed = structuredClone(seed);
  mixed.axes.recipeOccurrences = mixed.axes.readerShelfEntries;
  expect(() => seedCustodyCuts(mixed)).toThrow('incomplete');
  const substituted = structuredClone(seed);
  substituted.cuts = [{ manifest: { id: 'substituted' } } as RetainedSeedCut, ...seed.cuts.slice(1)];
  expect(() => seedCustodyCuts(substituted)).toThrow('incomplete');
});
