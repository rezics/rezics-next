/** Preparing retained data is an explicit command; ordinary QA only restores it. */
export const WORK_PROFILE_SEED_BUILD_FILE = 'tests/qa/fault-recovery/work-profile-seed-build.test.ts';
export const OWNER_ERASURE_SOURCE_BUILD_FILE = 'tests/qa/fault-recovery/owner-erasure-source-build.test.ts';
// Existing producer and physical preparation stages each keep their 600s bound.
export const OWNER_ERASURE_SOURCE_BUILD_WALL_MS = 2 * 600_000 + 120_000;

/** Six independent axes, each with three bounded 600-second stages, plus cleanup.
 * Every individual preparation and routine restore retains the same ceiling. */
export const WORK_PROFILE_SEED_BUILD_WALL_MS = 10_920_000;

/** Select consumers independently; a supplied (even invalid) source never falls back. */
export function smallRecoveryFixtureConsumers(files: readonly string[], environment: NodeJS.ProcessEnv) {
  return {
    launch: files.includes('tests/qa/fault-recovery/g-727-launch-drill.test.ts')
      && environment.G727_LAUNCH_SOURCE_RUN_ID === undefined
      && environment.G727_LAUNCH_FIXTURE === undefined
      && (environment.G727_LAUNCH_PROFILE ?? 'small') === 'small',
    erasure: files.includes('tests/qa/fault-recovery/erasure-campaign-qualification.test.ts')
      && (environment.ERASURE_CAMPAIGN_PROFILE ?? 'small') === 'small'
      && environment.ERASURE_CAMPAIGN_FIXTURE === undefined
      && environment.ERASURE_CAMPAIGN_SOURCES === undefined
      && environment.ERASURE_CAMPAIGN_COPY === undefined,
  };
}

/** Partition the existing project plan, giving registered consumers singleton commands. */
export function restoreDrillSchedule(projects: readonly (readonly string[])[], order: readonly string[]) {
  const selected = new Set(projects.flat());
  const serial = order.filter(file => selected.has(file)).map(file => [file]);
  const registered = new Set(order);
  const parallel = projects.map(files => files.filter(file => !registered.has(file))).filter(files => files.length);
  return { parallel, serial };
}

/** Directory, diagnostic and routine selections cannot accidentally rebuild retained data. */
export function preparationTestFiles(files: readonly string[], explicitlySelected?: readonly string[]): string[] {
  const builders = [WORK_PROFILE_SEED_BUILD_FILE, OWNER_ERASURE_SOURCE_BUILD_FILE];
  const requestedFile = builders.find(file => explicitlySelected?.includes(file));
  const requestedBuild = requestedFile !== undefined;
  if (requestedBuild && (explicitlySelected!.length !== 1 || files.length !== 1)) {
    throw new Error(`Select ${requestedFile} alone: retained preparation owns its wall.`);
  }
  return files.filter(file => !builders.includes(file) || file === requestedFile);
}

export function exclusivePreparationWallMs(files: readonly string[]): number | undefined {
  if (files.length !== 1) return undefined;
  if (files[0] === WORK_PROFILE_SEED_BUILD_FILE) return WORK_PROFILE_SEED_BUILD_WALL_MS;
  if (files[0] === OWNER_ERASURE_SOURCE_BUILD_FILE) return OWNER_ERASURE_SOURCE_BUILD_WALL_MS;
  if (files[0] === 'tests/qa/fault-recovery/g-727-launch-drill.test.ts') return 1_320_000;
  return undefined;
}
