import { bindRatingVoteSemantic } from '../rating/index.ts';
import { createNativeRatingVoteSemantic } from '../semantic/adapters/index.ts';

/** Server, worker and preload share one inert native vote binding and no startup writer. */
export function installRatingVoteSemantic(): void {
  bindRatingVoteSemantic(createNativeRatingVoteSemantic());
}
