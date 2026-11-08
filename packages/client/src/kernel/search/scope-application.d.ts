import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { CollectionAliasProgress, CollectionSourceObservation } from '../library/contract/source.ts';
import type { NativeOrdinalKey } from '../library/contract/ordering.ts';
import type { Access } from '../request/access.ts';
import type { LibraryActor } from '../library/contract/actors.ts';
import type { ScopeWorkContext } from '../library/adapters/index.ts';
import type { SearchLibraryScopePort, SearchScopeCollection, SearchScopeOrder, SearchScopeWorkDefinition } from './library-scope-port.ts';
export type SearchScopeReader = Readonly<{
    access: Access;
    deadline: number;
    actor?: LibraryActor;
    nativeT?: unknown;
    work?: ScopeWorkContext;
}>;
type ScopeCurrentWork = Readonly<{
    sourceIdentity: SearchScopeWorkDefinition['sourceIdentity'];
    observation: SearchScopeWorkDefinition['observation'];
    definition?: Readonly<{
        sort?: SearchScopeWorkDefinition['definition']['sort'];
    }>;
}>;
/** Application orchestration around the complete native Collection source capability. */
export declare function createSearchScopeOrderApplication(config: Readonly<{
    pool: Pool;
    options: SearchScopeReader;
    clock: KernelClock;
    library: SearchLibraryScopePort;
    readWorkDefinition: (work: ScopeWorkContext, options: Readonly<{
        pool: Pool;
        access: Access;
        deadline: number;
        library: SearchLibraryScopePort;
    }>) => Promise<ScopeCurrentWork>;
    selectedOrdinalPage: () => Readonly<{
        limit: number;
    }>;
}>): {
    prepare(order: SearchScopeOrder, allowance: WorkAllowance): Promise<Readonly<{
        collection: SearchScopeCollection;
        work: WorkReceipt;
    }>>;
    rawOrdinal(collection: SearchScopeCollection, after: NativeOrdinalKey | null, limit: number, allowance: WorkAllowance): Promise<Readonly<{
        kind: 'raw_curated_ordinal_prefix';
        rows: readonly import("../library/contract/source.ts").NativeOrdinalRow[];
        frontier: import("./library-scope-port.ts").NativeOrdinalFrontier;
        exhausted: boolean;
        observation: CollectionSourceObservation;
        work: WorkReceipt;
    }>>;
    prefix(collection: SearchScopeCollection, afterSubjectId: string | null, allowance: WorkAllowance, candidateLimit?: number): Promise<import("../library/collection-source.ts").CanonicalCollectionPrefix>;
    contains(collection: SearchScopeCollection, subjectId: string, allowance: WorkAllowance, progress?: CollectionAliasProgress): Promise<import("../library/collection-source.ts").CollectionSubjectMembership>;
};
/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export declare function sameScopeObservation(a: unknown, b: unknown): boolean;
export type { SearchScopeCollection, SearchScopeOrder };
