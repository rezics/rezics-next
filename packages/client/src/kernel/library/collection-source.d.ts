/** The sole Collection Source ABI and native runtime composition.
 * Ordinary owner-working calls use the registered server query context, never a caller purpose flag.
 * A selected public output and its curator's private working capture remain separate authorities.
 */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { RawOrdinalCollectionPrefix, ReadRawOrdinalCollectionPrefix } from './collection-source-order.ts';
import type { ScopeWorkContext } from './adapters/preparation-work.ts';
export { COLLECTION_SOURCE_DRIVER_COUNT } from './canonical-source-limits.ts';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
import type { WorkAllowance, WorkReceipt } from './contract/work-dimensions.ts';
export type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import { nativeEvidence, preparedSource, type CanonicalCollectionCandidate, type CanonicalCollectionPrefix, type CollectionAliasProgress, type CollectionSourceAfter, type CollectionSourceAuthority, type CollectionSourceBasis, type CollectionSourceObservation, type CollectionSourceEvidence, type CollectionSubjectMembership, type NativeIdentityBasis, type PreparedCollectionSource, type RawStoredCollectionPrefix } from './contract/index.ts';
export { nativeEvidence, preparedSource, type CanonicalCollectionCandidate, type CanonicalCollectionPrefix, type CollectionAliasProgress, type CollectionSourceAfter, type CollectionSourceAuthority, type CollectionSourceBasis, type CollectionSourceObservation, type CollectionSubjectMembership, type NativeIdentityBasis, type PreparedCollectionSource, type RawStoredCollectionPrefix, };
export type { CollectionSourceDriverOrdinal, CollectionSourceEvidence } from './contract/index.ts';
type SourceWorkContext<W extends ScopeWorkContext = ScopeWorkContext> = W extends ScopeWorkContext ? Readonly<{
    actor?: never;
    at?: never;
    work: W;
}> : never;
export type CollectionSourceContext = Readonly<{
    deadline: number;
}> & (Readonly<{
    actor: Actor;
    at: AuthoritativeTime;
    work?: never;
}> | SourceWorkContext);
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
/** Handles retain provenance, never Access. Every operation reauthorizes current source and identity scope. */
export declare function createCollectionSource(dependencies: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
    semanticObservations?: LibrarySemanticObservationCapability;
}): CollectionSource;
/** Local bridge for one ordinary page: fixed structural limits drive Source work, receipts still admit it. */
export declare function createOrdinaryCollectionPageSource(dependencies: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
    semanticObservations?: LibrarySemanticObservationCapability;
}): CollectionSource;
