// The kernel's view of the shared lane runner's timings: `scripts/test-lanes.ts` owns the mechanism.
import {
  orderFiles as orderFilesFor,
  timingsDirectory as timingsDirectoryFor,
  type FileTiming,
} from '../../../scripts/test-lanes.ts';

export {
  createRecorder,
  parseJunit,
  readLatestRun,
  readLatest,
  writeTimings,
  type CheckRunTiming,
  type FileTiming,
  type TestTiming,
} from '../../../scripts/test-lanes.ts';

/** The main checkout's timings directory, shared by every worktree; `KERNEL_CHECK_TIMINGS` overrides it. */
export function timingsDirectory(moduleDirectory: string, env: NodeJS.ProcessEnv = process.env): string {
  return timingsDirectoryFor('kernel', moduleDirectory, env);
}

/** Files with no recorded time first, then the rest by descending wall time; ties by name. */
export function orderFiles(
  files: string[],
  latest: Record<string, FileTiming>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return orderFilesFor('kernel', files, latest, env);
}
