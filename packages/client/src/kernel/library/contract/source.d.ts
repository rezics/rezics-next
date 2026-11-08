/** Stable Collection Source vocabulary. Pure types and numeric limits; no adapter or foreign imports. */
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './work-dimensions.ts';
import type { LibraryActor } from './actors.ts';
export declare const CANONICAL_SOURCE_RAW_KEY_LIMIT = 100;
export declare const COLLECTION_SOURCE_WORK_GROUP_LIMIT = 100;
export declare const COLLECTION_SOURCE_DRIVER_COUNT = 6;
export declare const ORDINARY_COLLECTION_PAGE_LIMIT = 100;
export declare const ORDINARY_COLLECTION_PREFIX_ROUNDS = 3;
/** Exact structural reference assignable from Semantic's IdentityBasis; no second brand or identity authority. */
export type NativeIdentityBasis = Readonly<{
    digest: string;
}>;
/** Native activation locator. Current source generation is a different field on the public-output identity. */
export type NativeOutputActivation = Readonly<{
    transactionId: string;
    position: string;
    sourceGeneration: string;
}>;
export type NativePublicOutputIdentity = Readonly<{
    scope: 'public_output';
    route: number;
    collectionId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
    outputGeneration: string;
    activation: NativeOutputActivation;
}>;
export type NativeAccountSourceIdentity = Readonly<{
    route: number;
    collectionId: string;
    accountId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
} & ({
    scope: 'curated' | 'private_builtin';
    outputGeneration?: never;
    publicationTransactionId?: never;
    publicationPosition?: never;
} | {
    scope: 'active_explicit_output';
    outputGeneration: string;
    publicationTransactionId: string;
    publicationPosition: string;
})>;
/** Lookup hints only. Native records, not possession of this value, establish custody. */
export type NativeSourceIdentity = NativeAccountSourceIdentity | NativePublicOutputIdentity;
export type CollectionSourceRawKey = Readonly<{
    driver: 'member' | 'entry' | 'label' | 'session' | 'copy' | 'output';
    storedSubjectId: string;
    factId: string;
}>;
export type NativeCollectionOrdinalPageBound = Readonly<{
    limit: number;
    requestBytes: number;
    resultBytes: number;
    work: WorkDimensions;
    projection: Readonly<Partial<WorkDimensions>>;
}>;
export type CanonicalSourceReceivingCost = Readonly<{
    state: WorkDimensions;
    seek: WorkDimensions;
    group: (limit: number) => WorkDimensions;
}>;
export interface CollectionSourceBasis {
    /** Commitment to the ACTUAL native query/meaning/profile/identity/projection compatibility inputs below. */
    readonly digest: string;
    readonly identity: NativeIdentityBasis;
    readonly query: string | null;
    readonly profilePins: readonly string[];
    readonly projection: string | null;
}
/** Authority references only; no query body, facts or permission claims. Private server-side evidence. */
export type CollectionSourceAuthority = {
    readonly kind: 'curated';
} | {
    readonly kind: 'private_builtin';
    readonly curatorAccountId: string | null;
} | {
    readonly kind: 'activated_output';
    readonly generation: string;
} | {
    readonly kind: 'frozen_output';
    readonly generation: string;
};
export type CollectionSourceStamp = Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
}>;
export interface CollectionSourceObservation {
    readonly collectionId: string;
    readonly route: number;
    /** Actual owner incarnation reference, not a newly invented revision counter. */
    readonly incarnation: string;
    readonly revision: number;
    readonly authority: CollectionSourceAuthority;
    /** Native partition observation, NOT structural meaning or a cross-page snapshot. */
    readonly stamp: CollectionSourceStamp;
    readonly basis: CollectionSourceBasis;
}
export declare const preparedSource: unique symbol;
/** Not an allow capability. Ordinary operations reauthorize actor/source/required subject anchors. */
export interface PreparedCollectionSource {
    readonly [preparedSource]: true;
    readonly observation: CollectionSourceObservation;
}
export declare const nativeEvidence: unique symbol;
/** Owner evidence reference; no public DTO/debug serialization. Not a fake Search Hit. */
export type CollectionSourceEvidence = {
    readonly [nativeEvidence]: true;
};
export interface CanonicalCollectionCandidate {
    readonly subjectId: string;
    readonly evidence: CollectionSourceEvidence;
}
export interface CanonicalCollectionPrefix {
    readonly kind: 'canonical_subject_prefix';
    readonly candidates: readonly CanonicalCollectionCandidate[];
    readonly coveredThrough: string | null;
    readonly exhausted: boolean;
    readonly observation: CollectionSourceObservation;
    readonly work: WorkReceipt;
}
export interface RawStoredCollectionPrefix {
    readonly kind: 'raw_stored_subject_prefix';
    readonly storedSubjectIds: readonly string[];
    readonly storedCoveredThrough: string | null;
    readonly storedExhausted: boolean;
    readonly observation: CollectionSourceObservation;
    readonly work: WorkReceipt;
}
export type CollectionSourceDriverOrdinal = 0 | 1 | 2 | 3 | 4 | 5;
export type CollectionSourceAfter = `1:${CollectionSourceDriverOrdinal}:${string}:${string}`;
export interface CollectionAliasProgress {
    readonly subjectId: string;
    readonly basisDigest: CollectionSourceBasis['digest'];
    readonly aliasAfter: string | null;
    readonly sourceAfter: CollectionSourceAfter | null;
}
export type NativeOrdinalKey = Readonly<{
    ordinalKey: string;
    memberId: string;
}>;
export type NativeOrdinalFrontier = Readonly<{
    after: NativeOrdinalKey | null;
}>;
export type NativeOrdinalRow = Readonly<{
    memberId: string;
    subjectId: string;
    ordinalKey: string;
    deletionId: string | null;
    deletedAt: string | null;
    memberRevision: number;
}>;
export type RawOrdinalCollectionPrefix = Readonly<{
    kind: 'raw_curated_ordinal_prefix';
    rows: readonly NativeOrdinalRow[];
    frontier: NativeOrdinalFrontier;
    exhausted: boolean;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export type CollectionSourceContext = Readonly<{
    deadline: number;
}> & (Readonly<{
    actor: LibraryActor;
    at: unknown;
    work?: never;
}> | Readonly<{
    actor?: never;
    at?: never;
    work: unknown;
}>);
export type PrepareCollectionSource = CollectionSourceContext & {
    readonly collectionId: string;
    readonly allowance: WorkAllowance;
};
export type CollectionSourceCall = CollectionSourceContext & {
    readonly source: PreparedCollectionSource;
    readonly allowance: WorkAllowance;
};
export type ContainsCollectionSubject = CollectionSourceCall & {
    readonly subjectId: string;
    readonly progress?: CollectionAliasProgress;
    readonly positiveEvidence?: CollectionSourceEvidence;
};
interface MembershipResultBase {
    readonly subjectId: string;
    readonly observation: CollectionSourceObservation;
    readonly work: WorkReceipt;
}
export type CollectionSubjectMembership = MembershipResultBase & ({
    readonly result: true;
    readonly positiveEvidence: CollectionSourceEvidence;
} | {
    readonly result: false;
    readonly negativeEvidence: CollectionSourceEvidence;
} | {
    readonly result: 'not_proven';
    readonly reason: 'allowance' | 'identity' | 'native_evidence' | 'owner_repair';
    readonly progress: CollectionAliasProgress | null;
});
export type ReadRawOrdinalCollectionPrefix = CollectionSourceCall & Readonly<{
    after: NativeOrdinalKey | null;
    limit: number;
}>;
export interface CollectionSource {
    prepare(input: PrepareCollectionSource): Promise<{
        source: PreparedCollectionSource;
        work: WorkReceipt;
    }>;
    prefix(input: CollectionSourceCall & {
        readonly afterSubjectId: string | null;
        readonly candidateLimit?: number;
    }): Promise<CanonicalCollectionPrefix>;
    containsSubject(input: ContainsCollectionSubject): Promise<CollectionSubjectMembership>;
    readRawStoredPrefix(input: CollectionSourceCall & {
        readonly afterStoredSubjectId: string | null;
    }): Promise<RawStoredCollectionPrefix>;
    readRawOrdinalPrefix(input: ReadRawOrdinalCollectionPrefix): Promise<RawOrdinalCollectionPrefix>;
}
export {};
