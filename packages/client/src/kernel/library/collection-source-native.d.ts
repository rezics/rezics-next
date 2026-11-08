import { type Pool, type PoolClient } from 'pg';
import { requireLibraryDomain } from './domain-binding.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type CommandTransaction, type AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { CanonicalRawKey } from './canonical-source-store.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/index.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';
import type { NativeOrdinalKey } from './collection-source-order.ts';
type NativePublicOutputOperations = NonNullable<ReturnType<typeof requireLibraryDomain>['nativePublicOutput']>;
/** Compatibility facade over the fully composed native public-output application. */
export declare function readNativePublicCollectionOutput(...args: Parameters<NativePublicOutputOperations['readNativePublicCollectionOutput']>): Promise<import("./native-public-output-contract.ts").PublicOutputPage>;
export declare function lockNativePublicCollectionOutput(...args: Parameters<NativePublicOutputOperations['lockNativePublicCollectionOutput']>): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: WorkReceipt;
}> | Readonly<{
    status: 'locked';
    tuple: import("./native-public-output-contract.ts").PublicOutputTuple;
    work: WorkReceipt;
}>>;
export declare function bindAndHoldNativePublicCollectionOutput(...args: Parameters<NativePublicOutputOperations['bindAndHoldNativePublicCollectionOutput']>): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: WorkReceipt;
}> | Readonly<{
    status: 'bound';
    binding: import("./native-public-output-contract.ts").NativePublicOutputBinding;
    work: WorkReceipt;
}>>;
export declare function revalidateNativePublicCollectionOutputHold(...args: Parameters<NativePublicOutputOperations['revalidateNativePublicCollectionOutputHold']>): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: WorkReceipt;
}> | Readonly<{
    status: 'locked';
    binding: import("./native-public-output-contract.ts").NativePublicOutputBinding;
    work: WorkReceipt;
}>>;
export declare function transferNativePublicCollectionOutputHold(...args: Parameters<NativePublicOutputOperations['transferNativePublicCollectionOutputHold']>): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: WorkReceipt;
}> | Readonly<{
    status: 'transferred';
    successorHoldId: string;
    transfer: import("./native-public-output-contract.ts").NativePublicOutputReceipt;
    work: WorkReceipt;
}>>;
export declare function releaseNativePublicCollectionOutputHold(...args: Parameters<NativePublicOutputOperations['releaseNativePublicCollectionOutputHold']>): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: WorkReceipt;
}> | Readonly<{
    status: 'released';
    release: import("./native-public-output-contract.ts").NativePublicOutputReceipt;
    work: WorkReceipt;
}>>;
/** Structural alias of the existing raw owner key; no canonical-order or Access claim. */
export type CanonicalRangeKey = CanonicalRawKey;
type Options = {
    deadline: number;
    allowance: WorkAllowance;
    /** Structural reads only. The Source work branch separately admits the actual native episode. */
    tx?: OperationalTransaction;
    /** Original native creation command; independent of mechanical work authority. */
    commandTx?: CommandTransaction;
};
type QueryClient = Pick<PoolClient, 'query'>;
type Ref = {
    route: number;
    collectionId: string;
};
type Header = Ref & {
    curatorAccountId: string | null;
    state: 'active' | 'deleted';
    visibility: 'private' | 'unlisted' | 'public';
    membershipKind: 'curated' | 'dynamic';
    revision: number;
    createdAt: string;
    sourceGeneration: string;
    builtinKind: 'everything' | 'state' | null;
    releaseDigest: string | null;
    profileId: string | null;
    stateSetId: string | null;
    stateId: string | null;
    ruleRevision?: string | null;
    ruleReleaseDigest?: string | null;
    ruleSource?: 'owner' | 'catalogue' | null;
    ruleReady?: boolean;
};
/** Private observation only. Possession grants no source or subject access. */
export type NativeCollectionMetadata = Readonly<Header & {
    incarnation: string;
    stamp: ListingStamp;
    factFence: string | null;
    authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
    /** Selected explicit COMPLETE membership only; never a private working generation. */
    outputGeneration: string | null;
    outputPublication: CollectionOutputPublication | null;
}>;
export type NativeCollectionWitness = Readonly<{
    incarnation: string;
    sourceGeneration: string;
    factFence: string | null;
}>;
type ProbeEvidence = {
    result: 'present';
    key: CanonicalRangeKey;
    progress: null;
    witness: NativeCollectionWitness;
} | {
    result: 'absent';
    key: null;
    progress: null;
    witness: null;
} | {
    result: 'not_proven';
    key: null;
    progress: CanonicalRangeKey | null;
    witness: null;
};
export type NativeCollectionProbe = ProbeEvidence & {
    work: WorkReceipt;
};
import type { CollectionOutputPublication } from './collection-source-output.ts';
export type { NativeCollectionOrdinalPageBound } from './contract/index.ts';
import type { NativeCollectionOrdinalPageBound } from './contract/index.ts';
/** The single native ordinal statement's literal and schema-width bounds. */
export declare function nativeCollectionOrdinalPageBound(limit: number): NativeCollectionOrdinalPageBound;
export declare const nativeCollectionPartitionMetadataSQL = "SELECT partition_no AS \"partitionNo\", write_state AS \"writeState\", epoch, position::text AS position FROM core.partition WHERE partition_no=$1";
export { COLLECTION_SOURCE_NATIVE_SAVED_PROBE_COST } from './collection-source-probe-bounds.ts';
export declare function nativeCollectionFootprint(sql: string, values: readonly unknown[], work?: NativeCollectionWork): WorkDimensions | undefined;
export declare function readNativeCollectionWorkingMetadata(pool: Pool, ref: Ref, options: Options): Promise<{
    metadata: Readonly<Ref & {
        curatorAccountId: string | null;
        state: 'active' | 'deleted';
        visibility: 'private' | 'unlisted' | 'public';
        membershipKind: 'curated' | 'dynamic';
        revision: number;
        createdAt: string;
        sourceGeneration: string;
        builtinKind: 'everything' | 'state' | null;
        releaseDigest: string | null;
        profileId: string | null;
        stateSetId: string | null;
        stateId: string | null;
        ruleRevision?: string | null;
        ruleReleaseDigest?: string | null;
        ruleSource?: 'owner' | 'catalogue' | null;
        ruleReady?: boolean;
    } & {
        incarnation: string;
        stamp: ListingStamp;
        factFence: string | null;
        authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
        /** Selected explicit COMPLETE membership only; never a private working generation. */
        outputGeneration: string | null;
        outputPublication: CollectionOutputPublication | null;
    }> | null;
} & {
    work: WorkReceipt;
}>;
/** Public-only observation on the caller's already metered snapshot/client. */
export declare function observeNativePublicCollectionOutput(client: QueryClient, ref: Ref, work: NativeCollectionWork): Promise<NativeCollectionMetadata | null>;
export declare function readNativeCollectionMetadata(pool: Pool, ref: Ref, options: Options): Promise<{
    metadata: Readonly<Ref & {
        curatorAccountId: string | null;
        state: 'active' | 'deleted';
        visibility: 'private' | 'unlisted' | 'public';
        membershipKind: 'curated' | 'dynamic';
        revision: number;
        createdAt: string;
        sourceGeneration: string;
        builtinKind: 'everything' | 'state' | null;
        releaseDigest: string | null;
        profileId: string | null;
        stateSetId: string | null;
        stateId: string | null;
        ruleRevision?: string | null;
        ruleReleaseDigest?: string | null;
        ruleSource?: 'owner' | 'catalogue' | null;
        ruleReady?: boolean;
    } & {
        incarnation: string;
        stamp: ListingStamp;
        factFence: string | null;
        authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
        /** Selected explicit COMPLETE membership only; never a private working generation. */
        outputGeneration: string | null;
        outputPublication: CollectionOutputPublication | null;
    }> | null;
} & {
    work: WorkReceipt;
}>;
export declare function readNativeCollectionMetadataWithWork(pool: Pool, ref: Ref, options: Options, work: NativeCollectionWork): Promise<{
    metadata: Readonly<Ref & {
        curatorAccountId: string | null;
        state: 'active' | 'deleted';
        visibility: 'private' | 'unlisted' | 'public';
        membershipKind: 'curated' | 'dynamic';
        revision: number;
        createdAt: string;
        sourceGeneration: string;
        builtinKind: 'everything' | 'state' | null;
        releaseDigest: string | null;
        profileId: string | null;
        stateSetId: string | null;
        stateId: string | null;
        ruleRevision?: string | null;
        ruleReleaseDigest?: string | null;
        ruleSource?: 'owner' | 'catalogue' | null;
        ruleReady?: boolean;
    } & {
        incarnation: string;
        stamp: ListingStamp;
        factFence: string | null;
        authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
        /** Selected explicit COMPLETE membership only; never a private working generation. */
        outputGeneration: string | null;
        outputPublication: CollectionOutputPublication | null;
    }> | null;
} & {
    work: WorkReceipt;
}>;
/** Selected Source adapter: exact metadata statements and multiplicity, with no allowance or work ledger. */
export declare function readNativeCollectionMetadataForWork(pool: Pool, ref: Ref, options: Readonly<{
    deadline: number;
    tx: OperationalTransaction;
    working?: boolean;
}>): Promise<{
    metadata: NativeCollectionMetadata | null;
}>;
/** Raw source discovery stays separate from Source.prepare and never executes the built-in query recursively. */
export declare function readNativeCollectionScopeIdentity(pool: Pool, input: Ref & Options): Promise<{
    identity: NativeSourceIdentity | null;
} & {
    work: WorkReceipt;
}>;
export declare function authorizeNativeCollectionMetadata(pool: Pool, metadata: NativeCollectionMetadata, context: Options & {
    access: Access;
    actor: Actor;
    at: AuthoritativeTime;
}): Promise<{
    authorized: boolean;
} & {
    work: WorkReceipt;
}>;
/** Internal raw data only: deletion episodes advance the same native ordinal frontier as live occurrences. */
export declare function readNativeCollectionRawOrdinalPage(pool: Pool, metadata: NativeCollectionMetadata, input: Options & {
    after: NativeOrdinalKey | null;
    limit: number;
}): Promise<{
    rows: Readonly<Pick<import("./collection-model.ts").CollectionMemberRow, "deletedAt" | "deletionId" | "memberId" | "memberRevision" | "ordinalKey" | "subjectId">>[];
    frontier: {
        after: Readonly<{
            ordinalKey: string;
            memberId: string;
        }> | null;
    };
    exhausted: boolean;
} & {
    work: WorkReceipt;
}>;
type RawPageInput = Options & {
    driver: CanonicalRangeKey['driver'];
    after: CanonicalRangeKey | null;
    limit: number;
};
export declare function readNativeCollectionRawPage(pool: Pool, metadata: NativeCollectionMetadata, input: RawPageInput): Promise<{
    rows: {
        key: {
            storedSubjectId: string;
            factId: string;
            driver: "copy" | "entry" | "label" | "member" | "output" | "session";
        };
    }[];
    after: CanonicalRawKey | null;
    exhausted: boolean;
} & {
    work: WorkReceipt;
}>;
export declare function readNativeCollectionRawPageWithWork(pool: Pool, metadata: NativeCollectionMetadata, input: RawPageInput, work: NativeCollectionWork): Promise<{
    rows: {
        key: {
            storedSubjectId: string;
            factId: string;
            driver: "copy" | "entry" | "label" | "member" | "output" | "session";
        };
    }[];
    after: CanonicalRawKey | null;
    exhausted: boolean;
} & {
    work: WorkReceipt;
}>;
/** Current original-source fact only. This result never authorizes original/terminal Subjects or disclosure. */
export declare function probeNativeCollectionOriginal(pool: Pool, metadata: NativeCollectionMetadata, input: Options & {
    originalId: string;
    keyHint?: CanonicalRangeKey;
    after?: CanonicalRangeKey | null;
}): Promise<NativeCollectionProbe>;
