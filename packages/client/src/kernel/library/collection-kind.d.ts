import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import type { Access, Actor } from '../request/access.ts';
import type { IdentityScopedObservations, IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { type NativeLibrarySourceCustody } from './native-source-custody.ts';
import { type CollectionSource, type CollectionAliasProgress, type CollectionSourceObservation, type CollectionSourceContext, type PreparedCollectionSource, type WorkAllowance, type WorkReceipt } from './collection-source.ts';
import type { KindAudienceAccess } from '../access/kind-audience.ts';
import type { WorkClient } from '../work/client.ts';
import type { KindConsentConsumer, KindConsentReference } from '@rezics/auth-contract';
/** Presentation arithmetic only. These values are not Source, identity or disclosure evidence. */
export type AutomaticCollectionKind = {
    presentationKind: string;
    presentationKindSource: 'members';
} | {
    presentationKind: null;
    presentationKindSource: 'empty' | 'pending';
};
export type CollectionKind = {
    presentationKind: null;
    presentationKindSource: 'mixed';
} | {
    presentationKind: string;
    presentationKindSource: 'owner';
};
/** A declaration's native predicate result for one canonical item. Unknown is
 * retained explicitly: it can only be ignored when a proven higher-ranked
 * declaration already wins that item. */
export type ConfiguredKindMatch = Readonly<{
    id: string;
    eligible: boolean;
    precedence: number;
    result: 'match' | 'no-match' | 'unknown';
}>;
export type ConfiguredKindVote = Readonly<{
    subjectId: string;
    matches: readonly ConfiguredKindMatch[];
}>;
export type ConfiguredKindReduction = Readonly<{
    status: 'selected';
    kindId: string;
}> | Readonly<{
    status: 'empty';
}> | Readonly<{
    status: 'unavailable';
}>;
/** Apply the versioned Kind policy after native evidence has classified each
 * declaration for every unique canonical item. Each item casts at most one
 * vote. A possibly winning unknown predicate makes the whole reduction
 * unavailable instead of silently falling back to a lower-ranked result. */
export declare function reduceConfiguredCollectionKinds(votes: readonly ConfiguredKindVote[]): ConfiguredKindReduction;
/** Unset presentation uses each member's Type hints; a stored owner choice needs no member evidence. */
export declare function collectionKind(override: string | null): CollectionKind;
/**
 * Repair-side reduction of COMPLETE current canonical visible support, keyed by terminal subject ID.
 * The native producer must establish completeness, currentness and canonical identity before using this result.
 * A missing observation must never be passed as an empty map. This function does not run on metadata GET.
 */
export declare function dominantCollectionKind(canonicalTypes: ReadonlyMap<string, string>): AutomaticCollectionKind;
export declare const COLLECTION_KIND_RAW_LIMIT = 100;
export declare const COLLECTION_KIND_BYTE_LIMIT = 4096;
export declare const pendingCollectionKind: () => AutomaticCollectionKind;
/** Opaque native retained observation, NOT a cached permission, invented epoch or serialized Actor. */
export type CollectionKindCapture = Readonly<{
    collectionId: string;
    accountId: string;
    audience: string;
    sourceGeneration: string;
    token: string;
    /** Auth enrollment lookup plus the exact Source generation; never ordinary authorization. */
    consent?: Readonly<{
        reference: KindConsentReference;
        consumer: KindConsentConsumer;
        captureGeneration: string;
        catalogueRoot: string;
    }>;
}>;
export type CollectionKindVote = Readonly<{
    subjectId: string;
    typeId: string;
}>;
type NativeUnavailable = Readonly<{
    status: 'unavailable';
    reason: 'source_unready';
}>;
export type CollectionKindPage = Readonly<{
    status: 'progress' | 'complete';
    afterSubject: string | null;
    /** Native retained unfinished-group locator, not a public cursor or a permission. */
    frontier: string | null;
    /** Raw examined work includes excluded/duplicate originals, not just votes. */
    examined: number;
    bytes: number;
    votes: readonly CollectionKindVote[];
}>;
/**
 * Owned integration boundary, not a new Source/matcher/permission API. The native binding must retain COMPLETE
 * original+terminal Type/disclosure/selective (including excluded/order) dependencies in existing custody.
 * A capture is audience-specific. Work never stores an Actor or mints a worker principal from an account ID.
 * Revalidation resolves retained native records, never trusts this locator or an old custody hold as fresh authority.
 */
export interface CollectionKindNative {
    /** Ephemeral original entry only; never part of a DBOS locator or restored Actor. */
    prepareInput?: KindAudienceAccess['resolveInput'];
    prepare(input: {
        collectionId: string;
        accountId: string;
        audience: string | null;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'prepared';
        capture: CollectionKindCapture;
    }>;
    page(input: {
        capture: CollectionKindCapture;
        afterSubject: string | null;
        frontier: string | null;
        inputLimit: number;
        byteLimit: number;
        deadline: number;
    }): Promise<NativeUnavailable | CollectionKindPage>;
    select(input: {
        collectionId: string;
        actor: Actor;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'selected';
        audience: string;
    }>;
    /** Includes fresh Collection authority and current grant after all foreign waits, as well as Type dependencies. */
    revalidate(input: {
        capture: CollectionKindCapture;
        actor?: Actor;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'current' | 'stale';
    }>;
    /** Same-home adoption of already retained native custody, with current account-T fencing and no foreign checkout.
     * OperationalTransaction is never cast to CommandTransaction to manufacture a native readAndHold call. */
    adopt(input: {
        capture: CollectionKindCapture;
        tx: OperationalTransaction;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'adopted' | 'stale';
    }>;
    /** Resolve exact native custody, release only this retired observation, never its business Source. */
    retire(input: {
        collectionId: string;
        accountId: string;
        token: string;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'retired';
    }>;
}
export type CollectionKindSourceBindings = Readonly<{
    source(access: Access): CollectionSource;
    identity: IdentityScopedObservations;
    custody: NativeLibrarySourceCustody;
    dependencies: CollectionKindPreparationDependencies;
}>;
export type CollectionKindPreparationDependencies = Readonly<{
    pool: Pool;
    clock?: KernelClock;
    access?: Access;
    routeKey?: Uint8Array;
    workClient?: WorkClient;
}>;
/** Real producer factories. Missing service configuration never becomes a worker principal. */
export declare function collectionKindSourceBindings(dependencies: CollectionKindPreparationDependencies): CollectionKindSourceBindings;
/** Native preparation owner; Source traversal remains in readCollectionKindSourcePage. */
export type CollectionKindPreparation = Omit<CollectionKindNative, 'page'> & {
    resume(input: {
        capture: CollectionKindCapture;
        deadline: number;
    }): Promise<NativeUnavailable | {
        status: 'prepared';
        step: Omit<CollectionKindSourceStep, 'collection' | 'afterSubject' | 'progress'>;
        access: Access;
        identity: IdentityScopeObservation;
    }>;
};
export declare function createCollectionKindNative(sources: CollectionKindSourceBindings, preparation?: CollectionKindPreparation): CollectionKindNative;
/**
 * Owned Source traversal for an admitted native repair step. Type projection is supplied by the native capture
 * binding with charged work, not a second Semantic reader. Never called by metadata GET. The same fresh opaque T,
 * actor and deadline bind prefix, original+terminal membership and Type projection. EOF is canonical Source EOF,
 * never raw EOF, a page limit, preview completion or count zero. No group is skipped when native proof is pending.
 */
export type CollectionKindSourceStep = Extract<CollectionSourceContext, {
    work?: never;
}> & {
    source: PreparedCollectionSource;
    collection: CollectionSource;
    allowance: WorkAllowance;
    afterSubject: string | null;
    progress?: CollectionAliasProgress;
    readType(request: {
        subjectId: string;
        at: AuthoritativeTime;
        actor: Actor;
        deadline: number;
        allowance: WorkAllowance;
    }): Promise<{
        status: 'current';
        typeId: string;
        work: WorkReceipt;
    } | {
        status: 'unavailable';
        work: WorkReceipt;
    }>;
};
export declare function readCollectionKindSourcePage(input: CollectionKindSourceStep): Promise<{
    status: 'settled';
    page: CollectionKindPage;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
} | {
    status: 'pending';
    afterSubject: string | null;
    pendingSubject: string;
    progress: CollectionAliasProgress | null;
    votes: readonly CollectionKindVote[];
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export declare function validateCollectionKindPage(page: CollectionKindPage, after: string | null, frontier?: string | null): void;
export {};
