import type { CollectionMemberRow, MemberPage } from './collection-model.ts';
import type { CollectionSourceCall, CollectionSourceObservation } from './collection-source.ts';
import type { WorkReceipt } from './contract/work-dimensions.ts';
export type NativeOrdinalKey = Readonly<NonNullable<MemberPage['after']>>;
export type NativeOrdinalFrontier = Readonly<{
    after: NativeOrdinalKey | null;
}>;
export type NativeOrdinalRow = Readonly<Pick<CollectionMemberRow, 'memberId' | 'subjectId' | 'ordinalKey' | 'deletionId' | 'deletedAt' | 'memberRevision'>>;
export type RawOrdinalCollectionPrefix = Readonly<{
    kind: 'raw_curated_ordinal_prefix';
    rows: readonly NativeOrdinalRow[];
    frontier: NativeOrdinalFrontier;
    exhausted: boolean;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export type ReadRawOrdinalCollectionPrefix = CollectionSourceCall & Readonly<{
    after: NativeOrdinalKey | null;
    limit: number;
}>;
