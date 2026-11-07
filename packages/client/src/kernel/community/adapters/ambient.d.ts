import type { CommunityAmbient, CommunityClock } from '../contract/index.ts';
/** Native wall-clock operands. Composition may override the deadline clock. */
export declare function createNativeCommunityAmbient(overrides?: Partial<CommunityAmbient>): CommunityAmbient;
/** Production operands. Composition roots pass it; focused tests pass a fixed one. */
export declare const systemCommunityAmbient: CommunityAmbient;
/** Production wall clock for the optional domain-clock operands Community still accepts. Adapter-level. */
export declare const systemCommunityClock: CommunityClock;
