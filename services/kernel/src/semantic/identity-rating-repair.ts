import { consumeIdentityRatingPage, snapshotIdentityRatingCheckpoint } from './identity-rating-consumer.ts';
import { snapshotIdentityRatingScope } from './identity-rating-adapter.ts';
import {
  IDENTITY_RATING_REPAIR_PAGE_LIMIT,
  type IdentityRatingParent,
  type IdentityRatingRepairScope,
  type IdentityRatingProvenanceResult,
  type IdentityRatingRepairCheckpoint,
  type IdentityRatingPageBinding,
} from './identity-rating-parent.ts';

export type IdentityRatingRepairResult =
  | Readonly<{
      status: 'complete';
      pages: number;
      provenance: Exclude<IdentityRatingProvenanceResult, 'stale' | 'continuing'>;
      checkpoint?: IdentityRatingRepairCheckpoint;
    }>
  | Readonly<{ status: 'pending'; pages: number; reason: string; checkpoint?: IdentityRatingRepairCheckpoint }>
  | Readonly<{ status: 'continuing'; pages: number; checkpoint?: IdentityRatingRepairCheckpoint }>;

/** Finish a visibility repair in bounded page steps; the parent releases provenance only after its final obligation. */
export async function repairIdentityRatingVisibility(
  parent: IdentityRatingParent,
  scope: IdentityRatingRepairScope,
  pageLimit = IDENTITY_RATING_REPAIR_PAGE_LIMIT,
  checkpoint?: IdentityRatingRepairCheckpoint,
): Promise<IdentityRatingRepairResult> {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > IDENTITY_RATING_REPAIR_PAGE_LIMIT)
    throw new RangeError('Identity rating repair page limit is outside its bound');
  const snapshot = snapshotIdentityRatingScope(scope);
  if (!snapshot) return { status: 'pending', pages: 0, reason: 'invalid-repair-scope' };
  scope = snapshot;
  // Native acknowledgement may have committed after the caller's last saved reply.
  checkpoint = (await parent.readRepairCheckpoint?.(scope)) ?? checkpoint;
  if (checkpoint) {
    const retained = snapshotIdentityRatingCheckpoint(scope, checkpoint);
    if (!retained) return { status: 'pending', pages: 0, reason: 'checkpoint-binding-mismatch' };
    checkpoint = retained;
  }
  if (checkpoint && checkpoint.phase !== 'repair') {
    const verified = await parent.verifyReclaimedCheckpoint?.(scope, checkpoint);
    if (verified === 'current')
      return {
        status: 'complete',
        pages: 0,
        provenance: 'already-reclaimed',
        checkpoint: Object.freeze({ ...checkpoint, phase: 'complete' }),
      };
    if (verified === 'stale' || checkpoint.phase === 'complete')
      return {
        status: 'pending',
        pages: 0,
        reason: verified === 'stale' ? 'provenance-owner-changed' : 'terminal-replay-unverified',
        checkpoint,
      };
  }

  let pages = 0;
  let after: IdentityRatingPageBinding | undefined = checkpoint?.phase === 'repair' ? checkpoint.binding : undefined;
  let replay = checkpoint?.phase === 'reclamation' ? checkpoint : undefined;
  while (pages < pageLimit) {
    const result = await consumeIdentityRatingPage(parent, scope, {
      ...(replay ? { replay } : {}),
      ...(after ? { after } : {}),
    });
    if (result.status === 'pending')
      return { status: 'pending', pages, reason: result.reason, ...(checkpoint ? { checkpoint } : {}) };
    replay = undefined;
    checkpoint = result.checkpoint;
    pages += 1;
    if (!result.terminal) {
      after = result.binding;
      continue;
    }

    const provenance = await parent.reclaimFinalProvenance(scope, result.receipt);
    if (provenance === 'stale') return { status: 'pending', pages, reason: 'provenance-owner-changed' };
    if (provenance === 'continuing') return { status: 'continuing', pages, ...(checkpoint ? { checkpoint } : {}) };
    if (checkpoint && provenance !== 'still-referenced')
      checkpoint = Object.freeze({ ...checkpoint, phase: 'complete' });
    return { status: 'complete', pages, provenance, ...(checkpoint ? { checkpoint } : {}) };
  }

  return { status: 'continuing', pages, ...(checkpoint ? { checkpoint } : {}) };
}
