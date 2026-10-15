import { expect, test } from 'bun:test';
import { exclusivePreparationWallMs, preparationTestFiles, smallRecoveryFixtureConsumers, WORK_PROFILE_SEED_BUILD_FILE, WORK_PROFILE_SEED_BUILD_WALL_MS,
  OWNER_ERASURE_SOURCE_BUILD_FILE, OWNER_ERASURE_SOURCE_BUILD_WALL_MS } from '../../../scripts/qa/preparation-selection.ts';

const restore = 'tests/qa/integration/work-profile-seed-checkpoints.test.ts';
const ordinary = 'tests/qa/fault-recovery/access-restore.test.ts';
const launch = 'tests/qa/fault-recovery/g-727-launch-drill.test.ts';
const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';

test('owner source builds are explicit, exclusive and retain both 600-second stages', () => {
  const build = OWNER_ERASURE_SOURCE_BUILD_FILE;
  expect(preparationTestFiles([ordinary, build])).toEqual([ordinary]);
  expect(preparationTestFiles([build], ['tests/qa/fault-recovery'])).toEqual([]);
  expect(preparationTestFiles([build], [build])).toEqual([build]);
  expect(() => preparationTestFiles([build, ordinary], [build, ordinary])).toThrow('alone');
  expect(exclusivePreparationWallMs([build])).toBe(OWNER_ERASURE_SOURCE_BUILD_WALL_MS);
  expect(OWNER_ERASURE_SOURCE_BUILD_WALL_MS).toBe(1_320_000);
});

test('retained fixture selection is independent for each consumer and never replaces supplied custody', () => {
  expect(smallRecoveryFixtureConsumers([launch, campaign], {})).toEqual({ launch: true, erasure: true });
  expect(smallRecoveryFixtureConsumers([launch], {})).toEqual({ launch: true, erasure: false });
  expect(smallRecoveryFixtureConsumers([campaign], {})).toEqual({ launch: false, erasure: true });
  expect(smallRecoveryFixtureConsumers([ordinary], {})).toEqual({ launch: false, erasure: false });
  for (const name of ['G727_LAUNCH_FIXTURE', 'G727_LAUNCH_SOURCE_RUN_ID', 'G727_LAUNCH_PROFILE']) {
    for (const value of ['', 'medium']) {
      expect(smallRecoveryFixtureConsumers([launch, campaign], { [name]: value }))
        .toEqual({ launch: false, erasure: true });
    }
  }
  for (const name of ['ERASURE_CAMPAIGN_FIXTURE', 'ERASURE_CAMPAIGN_SOURCES', 'ERASURE_CAMPAIGN_COPY', 'ERASURE_CAMPAIGN_PROFILE']) {
    for (const value of ['', 'medium']) {
      expect(smallRecoveryFixtureConsumers([launch, campaign], { [name]: value }))
        .toEqual({ launch: true, erasure: false });
    }
  }
});

test('retained seed preparation stays out of routine, directory and diagnostic selections', () => {
  expect(preparationTestFiles([ordinary, WORK_PROFILE_SEED_BUILD_FILE])).toEqual([ordinary]);
  expect(preparationTestFiles([ordinary, WORK_PROFILE_SEED_BUILD_FILE], ['tests/qa/fault-recovery'])).toEqual([ordinary]);
  expect(preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE])).toEqual([]);
  expect(preparationTestFiles([restore])).toEqual([restore]);
});

test('only the exact explicitly selected build file receives its exclusive wall', () => {
  const files = preparationTestFiles([WORK_PROFILE_SEED_BUILD_FILE], [WORK_PROFILE_SEED_BUILD_FILE]);
  expect(files).toEqual([WORK_PROFILE_SEED_BUILD_FILE]);
  expect(exclusivePreparationWallMs(files)).toBe(6 * 3 * 600_000 + 120_000);
  expect(WORK_PROFILE_SEED_BUILD_WALL_MS).toBe(10_920_000);
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
