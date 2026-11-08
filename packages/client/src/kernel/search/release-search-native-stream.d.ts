import { type FilterRelease } from '@rezics/filter';
import { type ReleaseSearchNameCut, type ReleaseSearchNamePool, type ReleaseSearchNameReservation } from './release-search-name-stream.ts';
import { type ReleaseGroupingBasis, type ReleaseGroupingRequest, type ReleaseGroupingSource } from './release-search-grouping.ts';
import { type SubjectSource } from './source.ts';
export type ReleaseSearchCandidatePool = ReleaseSearchNamePool & Readonly<{
    source: Pick<SubjectSource, 'read' | 'readCompleteWorkLinks'>;
}>;
/** Dispatch accounting only. The complete work-link owner has internal reads of its own.
 * Matching, card hydration, serialization and final disclosure still require native reservations.
 */
export type ReleaseSearchCandidateReservation = ReleaseSearchNameReservation & Readonly<{
    sourceReads: number;
    completeWorkLinkReads: number;
    completeWorkLinkOperations: number;
    authorityObservations: number;
    relationFacetReads?: number;
    hydrationReads?: number;
    serializationBytes?: number;
    searchReads: number;
}>;
export type ReleaseSearchCandidateContext = Readonly<{
    deadline: number;
    reserve: (reservation: ReleaseSearchCandidateReservation) => void;
    /** Full retained authority across ALL pools, beyond canonical-name publication. */
    observe: (context: {
        deadline: number;
        homesByPool: Readonly<Record<string, readonly {
            partition: number;
            position: string;
        }[]>>;
    }) => Promise<ReleaseGroupingBasis>;
}>;
type Context = ReleaseSearchCandidateContext;
export type ReleaseSearchCandidateCut = Readonly<{
    names: ReleaseSearchNameCut;
    basis: ReleaseGroupingBasis;
}>;
export type ReleaseSearchNativeCandidate = Readonly<{
    id: string;
    pool: string;
    partition: number;
    name: string | null;
    securityRevision: number;
    /** Opaque native search-after position immediately after this candidate. */
    after: string;
}>;
export type ReleaseSearchNativePage = Readonly<{
    keys: readonly ReleaseSearchNativeCandidate[];
    after: string;
    exhausted: boolean;
}>;
/** Retain full authority around the name population observation, including empty pools. */
export declare function observeReleaseSearchCandidates(pools: readonly ReleaseSearchCandidatePool[], context: Context): Promise<ReleaseSearchCandidateCut>;
/** Native name-order group and independent child streams. These are private candidate keys,
 * never matching results or public cards. The grouping policy must hydrate every emitted key.
 * One dispatch examines at most `size` native names; rejected names advance progress without
 * asserting EOF. Only the native owner's explicit EOF can terminate preparation.
 */
export declare function createReleaseSearchCandidateStreams(input: {
    pools: readonly ReleaseSearchCandidatePool[];
    release: FilterRelease;
    cut: ReleaseSearchCandidateCut;
    context: Context;
    relevance?: (request: ReleaseGroupingRequest, after: string | null, size: number) => Promise<ReleaseSearchNativePage>;
    currentMatches?: (request: ReleaseGroupingRequest, keys: readonly ReleaseSearchNativeCandidate[]) => Promise<ReadonlySet<string>>;
}): Pick<ReleaseGroupingSource<never, never>, 'groups' | 'children'>;
export {};
