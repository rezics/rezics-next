import type { Pool } from 'pg';

/** Provisional read shape; rating owns the completion and prior-vote evidence. */
export type RatingErasureStatus = { done: boolean; hadVotes: boolean };

export async function readRatingErasureDone(_deps: { pool: Pool }, _accountId: string): Promise<RatingErasureStatus> {
  const error = new Error('Community erasure phase unavailable: rating erasure status producer has not landed');
  error.name = 'CommunityErasureProducerUnavailableError';
  throw error;
}
