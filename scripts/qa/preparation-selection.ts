/** Preparing retained data is an explicit command; ordinary QA only restores it. */
export const WORK_PROFILE_SEED_BUILD_FILE = 'tests/qa/fault-recovery/work-profile-seed-build.test.ts';

/** Three independently bounded 600-second stages plus harness and cleanup. */
export const WORK_PROFILE_SEED_BUILD_WALL_MS = 1_920_000;

export const RETAINED_SOURCE_BUILD_FILE = 'tests/qa/fault-recovery/retained-source-preparation.test.ts';
/** Source production and backup are independently bounded at 600 seconds. */
export const RETAINED_SOURCE_BUILD_WALL_MS = 1_320_000;

const preparationWalls = new Map([
  [WORK_PROFILE_SEED_BUILD_FILE, WORK_PROFILE_SEED_BUILD_WALL_MS],
  [RETAINED_SOURCE_BUILD_FILE, RETAINED_SOURCE_BUILD_WALL_MS],
]);

/** Every standalone consumer prepares custody before its operation clock starts.
 * Confirmation selects outcome files independently of the source proof file. */
export function needsRealmDiscussionSource(files: readonly string[]): boolean {
  return files.some(file => file === 'tests/qa/integration/realm-discussion-source.test.ts'
    || file === 'tests/qa/integration/outcomes/realm/ranking.test.ts');
}

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
  const requestedBuild = explicitlySelected?.find(file => preparationWalls.has(file));
  if (requestedBuild && (explicitlySelected!.length !== 1 || files.length !== 1)) {
    throw new Error(`Select ${requestedBuild} alone: retained source preparation owns its wall.`);
  }
  return files.filter(file => !preparationWalls.has(file) || file === requestedBuild);
}

export function exclusivePreparationWallMs(files: readonly string[]): number | undefined {
  if (files.length !== 1) return undefined;
  const preparationWall = preparationWalls.get(files[0]!);
  if (preparationWall !== undefined) return preparationWall;
  if (files[0] === 'tests/qa/fault-recovery/g-727-launch-drill.test.ts') return 1_320_000;
  return undefined;
}
