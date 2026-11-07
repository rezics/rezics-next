import type { Pool, PoolClient } from 'pg';
import type { ResourceEligibility } from '../../access/index.ts';
import type { CommandTransaction } from '../../command/command.ts';
import type { Access, Actor } from '../../request/access.ts';
import type { RatingVoteSemantic as VotePort } from '../application/index.ts';

/** Native type binding; the application port itself has no runtime or adapter dependency. */
export type RatingVoteSemantic = VotePort<Pool, PoolClient, CommandTransaction, Access, Actor, ResourceEligibility>;

let installed: RatingVoteSemantic | undefined;

/** Host composition is the sole native writer. No native adapter is constructed on a Rating import. */
export function bindRatingVoteSemantic(port: RatingVoteSemantic): void {
  installed = port;
}

/** An omitted dependency uses installed composition, never permissive or synthetic currentness. */
export function ratingVoteSemantic(): RatingVoteSemantic {
  if (!installed) throw new TypeError('Rating vote Semantic capabilities are not installed');
  return installed;
}
