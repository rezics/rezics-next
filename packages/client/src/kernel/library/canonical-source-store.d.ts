/** Derived native access paths. References and ready pointers never grant membership or Access. */
import type { Pool } from 'pg';
import type { ListingStamp } from './listing-freshness-contract.ts';
/**
 * Reserved by the caller BEFORE dispatch; raw keys hard <=100, shared Zone aggregate <=256 including final use.
 * `nativeRows` maps directly to the shared Source `rows` allowance and is charged from plan-proved operation bounds.
 */
export interface CanonicalAllowance {
    readonly reservationId: string;
    readonly rawKeys: number;
    /** Charged plan-proved native row-work bound across all pools; reserve before dispatch, independently of raw keys. */
    readonly nativeRows: number;
    readonly nativePoints: number;
    readonly emptySeeks: number;
    readonly statements: number;
    readonly bytes: number;
    /** TWO released 4096-home sweeps per basis read; independently reserved before dispatch. */
    readonly identityMetadataRows: number;
}
export interface CanonicalWork {
    readonly reservationId: string;
    /** Disjoint categories; their sum <= allowance.rawKeys. Repeated encounters are charged again. */
    readonly candidateKeys: number;
    readonly aliasKeys: number;
    readonly duplicateKeys: number;
    readonly lookaheadKeys: number;
    readonly internalDriverKeys: number;
    /** Charged plan-proved native row-work bound, not result size, raw-key count or observed physical tuples. */
    readonly nativeRows: number;
    readonly nativePoints: number;
    readonly emptySeeks: number;
    readonly statements: number;
    readonly bytes: number;
    /** Actual metadata rows, including both sweeps; core-home observations also consume nativePoints. */
    readonly identityMetadataRows: number;
}
export type CanonicalAuthority = {
    readonly kind: 'curated';
} | {
    readonly kind: 'private_builtin';
    readonly curatorAccountId: string;
} | {
    readonly kind: 'activated_output';
    readonly generation: string;
} | {
    readonly kind: 'frozen_output';
    readonly generation: string;
};
/**
 * References ACTUAL selected owner authority and Semantic structural digest, not partition position or readiness.
 * The digest is the SAME commitment admitted by collection-source.ts, never a store-local substitute.
 * Semantic readIdentityBasis returns {digest:string}; actual code remains an independent dependency.
 * Never derive identity digest from labels, observations, fabricated epochs, positions or a local hash of fake data.
 */
export interface CanonicalBasis {
    /** Commitment to ALL actual references below, also bound into trusted continuation. */
    readonly digest: string;
    readonly incarnation: string;
    readonly authority: CanonicalAuthority;
    /** Membership/authority fence changed atomically by source mutations; editorial-only writes do not change it. */
    readonly sourceFence: string;
    readonly identity: Readonly<{
        digest: string;
    }>;
    /** Actual admitted meaning/profile/projection commitment, null for curated. */
    readonly meaning: string | null;
    /** State generations predating independent native support preparation cannot prove owner closure. */
    readonly originalCoverage?: 'owner-facts-v1';
}
export interface CanonicalSourceRef {
    readonly route: number;
    readonly collectionId: string;
}
export interface CanonicalCall extends CanonicalSourceRef {
    readonly deadline: number;
    readonly allowance: CanonicalAllowance;
}
export interface CanonicalBoundCall extends CanonicalCall {
    readonly basis: CanonicalBasis;
}
/** One fixed-width driver and two UUID keys; never notes, permissions, predicates or a set of visited IDs. */
export interface CanonicalRawKey {
    readonly driver: 'member' | 'entry' | 'label' | 'session' | 'copy' | 'output';
    readonly storedSubjectId: string;
    readonly factId: string;
}
/**
 * Exact owner sourceAfter handoff, 77 ASCII bytes after validation of lowercase UUIDs.
 * Ordinals 0..5 are member, entry, label, session, copy, output. Decode before SQL: encoded lexical order is
 * NOT the native (stored subject, driver, fact) order. No new public codec or nested token is defined here.
 */
export type CanonicalSourceAfter = `1:${0 | 1 | 2 | 3 | 4 | 5}:${string}:${string}`;
export interface CanonicalDerivedRow {
    readonly canonicalSubjectId: string;
    readonly key: CanonicalRawKey;
}
/** Single pending group. The canonical settled floor remains BEFORE pendingSubjectId until terminally decided. */
export interface CanonicalGroupProgress {
    readonly pendingSubjectId: string;
    readonly after: CanonicalRawKey | null;
    /** Last actually settled Semantic original, ONLY when a native alias window was consumed; absent means none. */
    readonly aliasAfter?: string | null;
    readonly generation: string;
    readonly basis: CanonicalBasis;
}
export type CanonicalNotReady = {
    readonly state: 'not_ready';
    readonly reason: 'source' | 'identity' | 'unbuilt' | 'incomplete' | 'stale' | 'allowance';
    readonly work: CanonicalWork;
};
export type CanonicalAuthorityRead = CanonicalNotReady | {
    readonly state: 'admitted';
    readonly basis: CanonicalBasis;
    readonly observation: ListingStamp;
    readonly work: CanonicalWork;
};
export type CanonicalReadyRead = CanonicalNotReady | {
    readonly state: 'ready';
    readonly basis: CanonicalBasis;
    readonly generation: string;
    readonly work: CanonicalWork;
};
/** Raw indexed candidates, not an authorized positive, complete negative, or public DTO. */
export type CanonicalGroupWindow = CanonicalNotReady | {
    readonly state: 'ready';
    readonly rows: readonly CanonicalDerivedRow[];
    readonly examinedThrough: CanonicalRawKey | null;
    readonly exhausted: boolean;
    readonly progress: CanonicalGroupProgress;
    readonly work: CanonicalWork;
};
export type CanonicalCandidateSeek = CanonicalNotReady | {
    readonly state: 'ready';
    readonly subjectId: string | null;
    /** Every candidate in (afterSubjectId, coveredThrough] represented; never the raw source floor. */
    readonly coveredThrough: string | null;
    readonly exhausted: boolean;
    readonly work: CanonicalWork;
};
export interface CanonicalRepair {
    readonly generation: string;
    readonly basis: CanonicalBasis;
    /** Durable last EXAMINED source key, including pending/rejected rows, committed with derived rows. */
    readonly after: CanonicalRawKey | null;
    readonly sourceExhausted: boolean;
}
export type CanonicalRepairRead = CanonicalNotReady | {
    readonly state: 'working';
    readonly repair: CanonicalRepair;
    readonly work: CanonicalWork;
};
export type CanonicalRepairStep = CanonicalNotReady | {
    readonly state: 'working' | 'complete' | 'basis_changed';
    readonly repair: CanonicalRepair;
    readonly examined: readonly CanonicalRawKey[];
    readonly work: CanonicalWork;
};
export type CanonicalPublication = CanonicalNotReady | {
    readonly state: 'published' | 'basis_changed' | 'incomplete';
    readonly work: CanonicalWork;
};
import type { WorkContext } from '../work/registry.ts';
import { type NativeSourceIdentity } from './native-source-custody.ts';
import { type NativeCollectionMetadata } from './collection-source-native.ts';
import type { WorkAllowance } from './collection-source.ts';
import { type CommandTransaction } from '../command/command.ts';
export declare const CANONICAL_SOURCE_WORKFLOW = "library.canonicalSource";
/** Bound once by the sole default Library WorkModule, using its real client and queues. */
export declare function bindCanonicalSourceWork(context: WorkContext): void;
export declare function nativeSourceFence(metadata: NativeCollectionMetadata): string;
/** Original native command only. Uses its SAME pool/transaction and existing Source identity storage. */
export declare function initializeCanonicalCollectionSource(tx: CommandTransaction, input: Readonly<{
    pool: Pool;
    route: number;
    collectionId: string;
    deadline: number;
    allowance: WorkAllowance;
}>): Promise<NativeSourceIdentity | null>;
export declare function observeCanonicalSource(pool: Pool, input: CanonicalCall): Promise<CanonicalAuthorityRead>;
export declare function readCanonicalSourceState(pool: Pool, input: CanonicalCall): Promise<CanonicalReadyRead>;
export declare function seekCanonicalSourceGroup(pool: Pool, input: CanonicalBoundCall & {
    generation: string;
    afterSubjectId: string | null;
}): Promise<CanonicalCandidateSeek>;
export declare function readCanonicalSourceGroup(pool: Pool, input: CanonicalBoundCall & {
    progress: CanonicalGroupProgress;
}): Promise<CanonicalGroupWindow>;
export declare function beginCanonicalSourceRepair(pool: Pool, input: CanonicalBoundCall): Promise<CanonicalRepairRead>;
export declare function repairCanonicalSourceStep(pool: Pool, input: CanonicalBoundCall & {
    repair: CanonicalRepair;
}): Promise<CanonicalRepairStep>;
export declare function publishCanonicalSourceRepair(pool: Pool, input: CanonicalBoundCall & {
    repair: CanonicalRepair;
}): Promise<CanonicalPublication>;
/** Bounded native population capture precedes canonical mapping; source originals include rejects/order inputs. */
export declare function advanceCanonicalSourceCapture(pool: Pool, input: CanonicalCall): Promise<CanonicalAuthorityRead>;
