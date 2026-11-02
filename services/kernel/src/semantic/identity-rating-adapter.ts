import { createHash } from 'node:crypto';
import type {
  IdentityRatingCommitReceipt,
  IdentityRatingPageBinding,
  IdentityRatingSelectedPage,
  IdentityRatingRepairScope,
} from './identity-rating-parent.ts';
import { IDENTITY_RATING_PAGE_LIMIT } from './identity-rating-parent.ts';

export type BoundIdentityRatingPage = Readonly<{
  page: IdentityRatingSelectedPage;
  binding: IdentityRatingPageBinding;
}>;

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

/** Bind every field that determines the effect, cursor, epoch, and owner of a selected page. */
export function bindIdentityRatingPage(
  scope: IdentityRatingRepairScope,
  page: IdentityRatingSelectedPage,
): BoundIdentityRatingPage | null {
  if (
    !nonEmpty(scope.subjectId) ||
    !nonEmpty(scope.securityRevision) ||
    !['visible', 'hidden', 'taken_down'].includes(scope.visibility) ||
    !nonEmpty(page.pageId) ||
    !nonEmpty(page.ownerId) ||
    !nonEmpty(page.ownerRevision) ||
    !nonEmpty(page.identityEpoch) ||
    !Array.isArray(page.items) ||
    page.items.length > IDENTITY_RATING_PAGE_LIMIT ||
    (page.after !== null && !nonEmpty(page.after)) ||
    (page.next !== null && !nonEmpty(page.next)) ||
    (page.terminal && page.next !== null) ||
    (!page.terminal && (page.next === null || page.next === page.after))
  )
    return null;

  const seen = new Set<string>();
  for (const item of page.items) {
    if (!nonEmpty(item.id) || !nonEmpty(item.revision) || !nonEmpty(item.targetId) || seen.has(item.id)) return null;
    if (item.units !== null && !Number.isSafeInteger(item.units)) return null;
    seen.add(item.id);
  }

  const snapshot: IdentityRatingSelectedPage = Object.freeze({
    pageId: page.pageId,
    ownerId: page.ownerId,
    ownerRevision: page.ownerRevision,
    identityEpoch: page.identityEpoch,
    after: page.after,
    next: page.next,
    terminal: page.terminal,
    items: Object.freeze(
      page.items.map((item) =>
        Object.freeze({
          id: item.id,
          revision: item.revision,
          targetId: item.targetId,
          units: item.units,
        }),
      ),
    ),
  });
  const selection = JSON.stringify({
    scope: [scope.subjectId, scope.visibility, scope.securityRevision],
    page: [
      snapshot.pageId,
      snapshot.ownerId,
      snapshot.ownerRevision,
      snapshot.identityEpoch,
      snapshot.after,
      snapshot.next,
      snapshot.terminal,
    ],
    items: snapshot.items.map((item) => [item.id, item.revision, item.targetId, item.units]),
  });
  const digest = createHash('sha256').update(selection).digest('hex');
  const binding = Object.freeze({
    subjectId: scope.subjectId,
    pageId: snapshot.pageId,
    digest,
    ownerId: snapshot.ownerId,
    ownerRevision: snapshot.ownerRevision,
    identityEpoch: snapshot.identityEpoch,
    after: snapshot.after,
    next: snapshot.next,
    terminal: snapshot.terminal,
  });
  return Object.freeze({ page: snapshot, binding });
}

export function identityRatingReceiptMatches(
  binding: IdentityRatingPageBinding,
  receipt: IdentityRatingCommitReceipt,
): boolean {
  return (
    receipt.pageId === binding.pageId &&
    receipt.selectionDigest === binding.digest &&
    receipt.ownerId === binding.ownerId &&
    receipt.ownerRevision === binding.ownerRevision &&
    receipt.identityEpoch === binding.identityEpoch &&
    receipt.terminal === binding.terminal &&
    nonEmpty(receipt.transactionId) &&
    nonEmpty(receipt.position)
  );
}
