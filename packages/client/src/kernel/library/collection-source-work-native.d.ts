import type { Pool } from 'pg';
import { readScopeWorkDefinition, type ScopeWorkContext } from '../search/scope-work-context.ts';
import type { Access } from '../request/access.ts';
import { type CanonicalBasis, type CanonicalRawKey } from './canonical-source-store.ts';
import { type NativeCollectionMetadata } from './collection-source-native.ts';
import type { CollectionSourceObservation, WorkAllowance } from './collection-source.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
export type CollectionSourceWorkDefinition = Awaited<ReturnType<typeof readScopeWorkDefinition>>;
export type CollectionSourceWorkState = Readonly<{
    metadata: NativeCollectionMetadata;
    basis: CanonicalBasis;
    generation: string;
    observation: CollectionSourceObservation;
    definition: CollectionSourceWorkDefinition;
}>;
/** Rereads actual native admission before I/O, then compares its binding to current local Source records.
 * The Source repeats this whole operation before returning. This data never grants Access.
 */
export declare function readCollectionSourceWorkState(pool: Pool, work: ScopeWorkContext, options: Readonly<{
    access: Access;
    deadline: number;
    allowance: WorkAllowance;
}>): Promise<{
    metadata: Readonly<{
        route: number;
        collectionId: string;
    } & {
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
        ruleReady?: boolean;
    } & {
        incarnation: string;
        stamp: import("./listing-freshness-contract.ts").ListingStamp;
        factFence: string | null;
        authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
        outputGeneration: string | null;
        outputPublication: import("./collection-source-output.ts").CollectionOutputPublication | null;
    }>;
    basis: CanonicalBasis;
    generation: string;
    observation: CollectionSourceObservation;
    definition: Readonly<{
        releaseDigest: string;
        audience: string;
        sourceIdentity: NativeSourceIdentity;
        observation: CollectionSourceObservation;
        identityObservation: import("../semantic/identity-scope-types.ts").IdentityScopeObservation;
        repairReceipt: import("../semantic/identity-epoch-contract.ts").IdentityNativeReceipt;
        custody: import("./native-source-custody.ts").NativeSourceCustody;
    }> | Readonly<{
        definition: import("./members-preparation.ts").PreparationDefinition;
        sourceIdentity: NativeSourceIdentity;
        observation: CollectionSourceObservation;
    }> | import("./collection-publication-work-admission.ts").CollectionPublicationWorkDefinition;
    work: import("./collection-source.ts").WorkReceipt;
}>;
/** Exact seek in the existing COMPLETE canonical generation, not a new producer or a public subject reader. */
export declare function seekCollectionSourceWorkGroup(work: ScopeWorkContext, state: CollectionSourceWorkState, after: string | null, options: Readonly<{
    deadline: number;
    allowance: WorkAllowance;
}>): Promise<{
    subjectId: string | null;
    work: import("./collection-source.ts").WorkReceipt;
}>;
export declare function readCollectionSourceWorkGroup(work: ScopeWorkContext, state: CollectionSourceWorkState, subjectId: string, after: CanonicalRawKey | null, limit: number, options: Readonly<{
    deadline: number;
    allowance: WorkAllowance;
}>): Promise<{
    rows: {
        key: CanonicalRawKey;
    }[];
    exhausted: boolean;
    work: import("./collection-source.ts").WorkReceipt;
}>;
