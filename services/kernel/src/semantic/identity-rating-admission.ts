import type { CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { withReadTransaction } from './read.ts';
import { VoteReviewStaleError, VoteReviewUnavailableError, type VoteReviewEpoch } from '../rating/own-votes-review.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityEpochStore } from './identity-adapters/index.ts';
import type { IdentityEpochState } from './identity-epoch-contract.ts';
import admission from './identity-rating-admission.sql';

export type IdentityRatingAdmissionReason = 'redirect-chain' | 'epoch-pending' | 'source-pending';
export type IdentityRatingAdmissionResult =
  | Readonly<{ status: 'admitted'; subjectId: string }>
  | Readonly<{ status: 'pending'; reason: IdentityRatingAdmissionReason }>;

export type IdentityRatingEpochReader = (tx: CommandTransaction, home: number) => Promise<IdentityEpochState>;

/** Released native-home observations. These do not fence identity publication through an owner commit. */
export async function readIdentityRatingEpochs(pool: Pool, homes: readonly number[], deadline: number) {
  const epochs: VoteReviewEpoch[] = [];
  for (const partition of [...new Set(homes)].sort((a, b) => a - b)) {
    const state = await withReadTransaction(
      pool,
      async (client) => {
        await partitionReadClient(client, partition);
        return identityEpochStore.readEpoch(client, partition);
      },
      deadline,
    );
    if (state.state === 'pending') throw new VoteReviewUnavailableError('identity_pending');
    if (state.state !== 'published') throw new VoteReviewUnavailableError('identity_observation_unavailable');
    epochs.push({ partition, epoch: state.epoch.toString() });
  }
  return epochs;
}

export function compareIdentityRatingEpochs(expected: readonly VoteReviewEpoch[], actual: readonly VoteReviewEpoch[]) {
  if (
    expected.length !== actual.length ||
    expected.some(
      (entry, index) => entry.partition !== actual[index]?.partition || entry.epoch !== actual[index]?.epoch,
    )
  )
    throw new VoteReviewStaleError('identity_epoch_changed');
}

/**
 * Revalidate the pre-resolved target in the voter's transaction. A newly installed direct
 * redirect or an open identity epoch leaves this command attempt retryable before any vote write.
 */
export async function admitIdentityRatingEffect(
  tx: CommandTransaction,
  input: Readonly<{
    requestedTargetId: string;
    resolvedTargetId: string;
    expectedEpochs?: readonly VoteReviewEpoch[];
  }>,
  readEpoch: IdentityRatingEpochReader = (transaction, home) => identityEpochStore.readEpoch(transaction, home),
): Promise<IdentityRatingAdmissionResult> {
  const requestedRoute = routeOf(input.requestedTargetId);
  const resolvedRoute = routeOf(input.resolvedTargetId);
  if (requestedRoute === null || resolvedRoute === null) return { status: 'pending', reason: 'source-pending' };

  const row = await admission.run(tx, { subject_id: input.resolvedTargetId });
  if (!row || row.subjectId !== input.resolvedTargetId || row.activeTerminal !== true)
    return { status: 'pending', reason: 'source-pending' };
  if (row.redirect !== null) return { status: 'pending', reason: 'redirect-chain' };

  const homes = [...new Set([partitionOf(requestedRoute), partitionOf(resolvedRoute)])].sort(
    (left, right) => left - right,
  );
  const epochs: VoteReviewEpoch[] = [];
  for (const home of homes) {
    const state = await readEpoch(tx, home);
    if (state.state === 'pending') return { status: 'pending', reason: 'epoch-pending' };
    if (state.state === 'unavailable') return { status: 'pending', reason: 'source-pending' };
    epochs.push({ partition: home, epoch: state.epoch.toString() });
  }
  if (input.expectedEpochs) compareIdentityRatingEpochs(input.expectedEpochs, epochs);
  return { status: 'admitted', subjectId: input.resolvedTargetId };
}

export class IdentityRatingAdmissionPendingError extends Error {
  readonly code = 'identity_rating_pending';

  constructor(
    readonly targetId: string,
    readonly reason: IdentityRatingAdmissionReason,
  ) {
    super(`Identity rating admission is pending for ${targetId}: ${reason}`);
    this.name = 'IdentityRatingAdmissionPendingError';
  }
}
