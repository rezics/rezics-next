/** Mutation decisions contain no reads, clock, permission or transaction authority. */
import type { Collection, CollectionMetadataField, CollectionMetadataSnapshot } from '../contract/index.ts';
export declare function collectionMetadataChangedFields(before: CollectionMetadataSnapshot, after: CollectionMetadataSnapshot): CollectionMetadataField[];
export declare function collectionMetadataMutationPlan(before: Collection, after: Collection): Readonly<{
    retirePublication: boolean;
    reducePublicSource: boolean;
    reread: boolean;
}>;
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
export declare function collectionRetentionDisposition(accountLive: boolean, parent: CollectionRetentionHead | null, key: Readonly<{
    accountId: string;
    deletionId: string;
    revision: number;
}>): 'account_fence' | 'stale' | 'not_due' | 'remove';
