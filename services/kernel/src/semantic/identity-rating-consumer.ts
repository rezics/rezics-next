import {
  bindIdentityRatingPage,
  identityRatingReceiptMatches,
  identityRatingText,
  snapshotIdentityRatingScope,
} from './identity-rating-adapter.ts';
import {
  IDENTITY_RATING_PAGE_LIMIT,
  type IdentityRatingCommitReceipt,
  type IdentityRatingParent,
  type IdentityRatingRepairScope,
  type IdentityRatingPageBinding,
  type IdentityRatingRepairCheckpoint,
} from './identity-rating-parent.ts';

export type IdentityRatingPageResult =
  | Readonly<{
      status: 'committed';
      pageId: string;
      terminal: boolean;
      receipt: IdentityRatingCommitReceipt;
      binding: IdentityRatingPageBinding;
      checkpoint?: IdentityRatingRepairCheckpoint;
    }>
  | Readonly<{ status: 'pending'; reason: string }>;

/** Process at most one immutable native page. A committed receipt is replayed before selecting new work. */
export async function consumeIdentityRatingPage(
  parent: IdentityRatingParent,
  scope: IdentityRatingRepairScope,
  request: Readonly<{ replay?: IdentityRatingRepairCheckpoint; after?: IdentityRatingPageBinding }> = {},
): Promise<IdentityRatingPageResult> {
  const snapshot = snapshotIdentityRatingScope(scope);
  if (!snapshot) return { status: 'pending', reason: 'invalid-repair-scope' };
  scope = snapshot;
  const replay = request.replay ? snapshotIdentityRatingCheckpoint(scope, request.replay) : undefined;
  if (request.replay && !replay) return { status: 'pending', reason: 'checkpoint-binding-mismatch' };
  const selected = await parent.selectPage(scope, IDENTITY_RATING_PAGE_LIMIT, replay?.binding);
  const bound = bindIdentityRatingPage(scope, selected);
  if (!bound) return { status: 'pending', reason: 'invalid-selected-page' };
  const { page, binding } = bound;
  if (replay && binding.digest !== replay.binding.digest)
    return { status: 'pending', reason: 'checkpoint-binding-mismatch' };
  if (request.after && (page.after !== request.after.next || binding.digest === request.after.digest))
    return { status: 'pending', reason: 'repair-frontier-did-not-advance' };

  let receipt = await parent.readCommitReceipt(binding);
  if (!receipt) {
    const committed = await parent.commitSelectedPage(scope, page, binding);
    if (committed.status === 'pending') return committed;
    receipt = committed.receipt;
  }

  receipt = Object.freeze(receipt);
  if (!identityRatingReceiptMatches(binding, receipt)) return { status: 'pending', reason: 'receipt-binding-mismatch' };
  if (
    replay &&
    (receipt.transactionId !== replay.receipt.transactionId || receipt.position !== replay.receipt.position)
  )
    return { status: 'pending', reason: 'checkpoint-receipt-mismatch' };
  if (!(await parent.verifyCommitReceipt(scope, page, binding, receipt)))
    return { status: 'pending', reason: 'commit-receipt-unverified' };
  if (!(await parent.acknowledgeSelectedPage(scope, page, binding, receipt)))
    return { status: 'pending', reason: 'selected-page-acknowledgement-pending' };

  const checkpoint: IdentityRatingRepairCheckpoint | undefined = binding.native
    ? Object.freeze({
        scope,
        phase: page.terminal ? 'reclamation' : 'repair',
        binding: Object.freeze({ ...binding, native: binding.native }),
        receipt,
      })
    : undefined;
  return {
    status: 'committed',
    pageId: page.pageId,
    terminal: page.terminal,
    receipt,
    binding,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

export function snapshotIdentityRatingCheckpoint(
  scope: IdentityRatingRepairScope,
  checkpoint: IdentityRatingRepairCheckpoint,
): IdentityRatingRepairCheckpoint | null {
  const b = checkpoint.binding,
    r = checkpoint.receipt,
    n = b.native;
  if (
    !(
      checkpoint.scope.subjectId === scope.subjectId &&
      checkpoint.scope.visibility === scope.visibility &&
      checkpoint.scope.securityRevision === scope.securityRevision &&
      checkpoint.binding.subjectId === scope.subjectId &&
      [b.pageId, b.ownerId, b.ownerRevision, b.identityEpoch, n?.frontier, n?.phase, n?.revision].every(
        identityRatingText,
      ) &&
      /^[a-f0-9]{64}$/.test(b.digest) &&
      typeof b.terminal === 'boolean' &&
      (b.after === null || identityRatingText(b.after)) &&
      (b.next === null || identityRatingText(b.next)) &&
      (b.terminal ? b.next === null : b.next !== null && b.next !== b.after) &&
      identityRatingReceiptMatches(checkpoint.binding, checkpoint.receipt) &&
      (checkpoint.phase === 'repair'
        ? !checkpoint.binding.terminal
        : (checkpoint.phase === 'reclamation' || checkpoint.phase === 'complete') && checkpoint.binding.terminal)
    )
  )
    return null;
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    phase: checkpoint.phase,
    binding: Object.freeze({
      subjectId: scope.subjectId,
      pageId: b.pageId,
      digest: b.digest,
      ownerId: b.ownerId,
      ownerRevision: b.ownerRevision,
      identityEpoch: b.identityEpoch,
      after: b.after,
      next: b.next,
      terminal: b.terminal,
      native: Object.freeze({ frontier: n.frontier, phase: n.phase, revision: n.revision }),
    }),
    receipt: Object.freeze({
      pageId: r.pageId,
      selectionDigest: r.selectionDigest,
      ownerId: r.ownerId,
      ownerRevision: r.ownerRevision,
      identityEpoch: r.identityEpoch,
      transactionId: r.transactionId,
      position: r.position,
      terminal: r.terminal,
    }),
  });
}
