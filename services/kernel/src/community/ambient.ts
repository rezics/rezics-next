/**
 * Ambient operands that composition supplies to Community. Domain time stays a `KernelClock`
 * passed beside them; `deadlineNow` is real wall time for request and evidence deadlines.
 * Application code reads these only through its dependencies, never from a global.
 */
export type CommunityAmbient = Readonly<{
  /** Current wall time in milliseconds, compared with request deadlines. Never domain time. */
  deadlineNow: () => number;
}>;

/** Production operands. Composition roots pass it; focused tests pass a fixed one. */
export const systemCommunityAmbient: CommunityAmbient = Object.freeze({
  deadlineNow: () => Date.now(),
});
