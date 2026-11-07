/** Mutation decisions contain no reads, clock, permission or transaction authority. */
import type { Collection, CollectionMetadataField, CollectionMetadataSnapshot } from '../contract/index.ts';
import { COLLECTION_METADATA_FIELDS } from '../contract/index.ts';

export function collectionMetadataChangedFields(
  before: CollectionMetadataSnapshot,
  after: CollectionMetadataSnapshot,
): CollectionMetadataField[] {
  return COLLECTION_METADATA_FIELDS.filter((field) => before[field] !== after[field]);
}

export function collectionMetadataMutationPlan(before: Collection, after: Collection) {
  const wasListed = before.state === 'active' && before.visibility === 'public';
  const isListed = after.state === 'active' && after.visibility === 'public';
  return Object.freeze({
    retirePublication: before.membershipKind === 'dynamic' && before.visibility !== after.visibility,
    reducePublicSource: (wasListed && !isListed) || (before.visibility !== 'private' && after.visibility === 'private'),
    reread: before.membershipKind === 'dynamic',
  });
}

export type CollectionRetentionHead = Readonly<{
  accountId: string | null;
  state: string;
  deletionId: string | null;
  revision: number;
  sourceGeneration: string;
  deadlineMatches: boolean | null;
  due: boolean | null;
  publicCustody: boolean;
  sourceCustody: boolean;
}>;

/** Exact deletion episode and expiry are native locked observations, never a caller's inferred deadline. */
export function collectionRetentionDisposition(
  accountLive: boolean,
  parent: CollectionRetentionHead | null,
  key: Readonly<{ accountId: string; deletionId: string; revision: number }>,
): 'account_fence' | 'stale' | 'not_due' | 'remove' {
  if (!accountLive) return 'account_fence';
  if (
    !parent ||
    parent.accountId !== key.accountId ||
    parent.state !== 'deleted' ||
    parent.deletionId !== key.deletionId ||
    parent.revision !== key.revision ||
    !parent.deadlineMatches
  )
    return 'stale';
  return parent.due ? 'remove' : 'not_due';
}
