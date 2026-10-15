import { expect, test } from 'bun:test';
import { SEED_AXES, seedCheckpointPlan } from '../support/seed-checkpoint-plan.ts';
import { WORK_PROFILE_DIMENSIONS, workProfileDimensions } from '../../../scripts/load/work-profile-corpus.ts';

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
