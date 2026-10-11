import { expect, test } from 'bun:test';
import { exclusivePreparationWallMs, preparationTestFiles, WORK_PROFILE_SEED_BUILD_FILE, WORK_PROFILE_SEED_BUILD_WALL_MS } from '../../../scripts/qa/preparation-selection.ts';

const restore = 'tests/qa/integration/work-profile-seed-checkpoints.test.ts';
const ordinary = 'tests/qa/fault-recovery/access-restore.test.ts';

test('retained seed preparation stays out of routine, directory and diagnostic selections', () => {
  expect(preparationTestFiles([ordinary, WORK_PROFILE_SEED_BUILD_FILE])).toEqual([ordinary]);
  expect(preparationTestFiles([ordinary, WORK_PROFILE_SEED_BUILD_FILE], ['tests/qa/fault-recovery'])).toEqual([ordinary]);
  expect(preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE])).toEqual([]);
  expect(preparationTestFiles([restore])).toEqual([restore]);
});

test('only the exact explicitly selected build file receives its exclusive wall', () => {
  const files = preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE], [WORK_PROFILE_SEED_BUILD_FILE]);
  expect(files).toEqual([WORK_PROFILE_SEED_BUILD_FILE]);
  expect(exclusivePreparationWallMs(files)).toBe(3 * 600_000 + 120_000);
  expect(WORK_PROFILE_SEED_BUILD_WALL_MS).toBe(1_920_000);
  expect(exclusivePreparationWallMs([restore])).toBeUndefined();
  expect(exclusivePreparationWallMs([ordinary])).toBeUndefined();
  expect(exclusivePreparationWallMs(['tests/qa/fault-recovery/g-727-launch-drill.test.ts'])).toBe(1_320_000);
});

test('a build cannot share its preparation command with other tests', () => {
  expect(() => preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE, ordinary], [WORK_PROFILE_SEED_BUILD_FILE, ordinary]))
    .toThrow('alone');
  expect(() => preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE, ordinary], [WORK_PROFILE_SEED_BUILD_FILE]))
    .toThrow('alone');
  expect(exclusivePreparationWallMs([WORK_PROFILE_SEED_BUILD_FILE, ordinary])).toBeUndefined();
});
