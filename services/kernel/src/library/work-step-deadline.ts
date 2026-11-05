/**
 * Deadline in milliseconds of one Library work step.
 *
 * This module imports nothing. Bound declarations that read the value at module load import it from here rather than
 * from command-support.ts, because that module sits in an import cycle and could still be evaluating when they run.
 */
export const WORK_STEP_DEADLINE_MS = 5_000;
