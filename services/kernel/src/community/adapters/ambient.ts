import type { CommunityAmbient, CommunityClock } from '../contract/index.ts';

/** Native wall-clock operands. Composition may override the deadline clock. */
export function createNativeCommunityAmbient(overrides: Partial<CommunityAmbient> = {}): CommunityAmbient {
  return Object.freeze({
    deadlineNow: overrides.deadlineNow ?? (() => Date.now()),
  });
}

/** Production operands. Composition roots pass it; focused tests pass a fixed one. */
export const systemCommunityAmbient: CommunityAmbient = createNativeCommunityAmbient();

/** Production wall clock for the optional domain-clock operands Community still accepts. Adapter-level. */
export const systemCommunityClock: CommunityClock = () => new Date();
