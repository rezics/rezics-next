/** Rating presentation contract consumed by Search; the native read stays owner-owned. */
export type { PublicFigureView } from './public-figure-http.ts';
/** Vote observation type contract consumed by Library list-import. */
export type { VoteObservation } from './vote-observation.ts';
/** Host composition binds the Semantic producer through this port; HTTP consumes the bound instance. */
export type {
  RatingIdentityAuthority,
  RatingIdentityMapping,
  RatingIdentityProducer,
} from './segment-identity-guard.ts';
export {
  bindRatingIdentityProducer,
  ratingIdentityProducer,
  unavailableRatingIdentityProducer,
} from './segment-identity-guard.ts';

export { bindRatingVoteSemantic, ratingVoteSemantic } from './adapters/vote-semantic.ts';
export type { RatingVoteSemantic } from './adapters/vote-semantic.ts';
