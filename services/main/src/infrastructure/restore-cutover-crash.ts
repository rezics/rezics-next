/** Process environment that arms the cutover crash seam. Production compose,
 * the release manifest and production preflight do not set it. */
export const RESTORE_CUTOVER_CRASH_FLAG = 'REZICS_QA_RESTORE_CUTOVER_CRASH';

/** Stops after the cutover command has committed. Both names are that one
 * durable graph: the data-epoch swap, routing-epoch change, sequence reset,
 * RestoreCutover marker and hold are a single command. Nothing in the cutover
 * clears the hold; release does. A bare epoch swap (sequence 0,
 * RestoreCutover, no hold, routing epoch unchanged) is not a stop here. */
export const RESTORE_CUTOVER_CRASH_POINTS = [
  'after-hold-written',
  'after-epoch-swap-before-hold-clears',
] as const;
export type RestoreCutoverCrashPoint = typeof RESTORE_CUTOVER_CRASH_POINTS[number];

/** The seam is inert unless a test names a point and this process is explicitly armed. */
export function restoreCutoverCrashArmed(point: string | undefined): point is RestoreCutoverCrashPoint {
  return (point === 'after-hold-written' || point === 'after-epoch-swap-before-hold-clears')
    && process.env.NODE_ENV !== 'production'
    && process.env[RESTORE_CUTOVER_CRASH_FLAG] === '1';
}
