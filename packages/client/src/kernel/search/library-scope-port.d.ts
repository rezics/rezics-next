/** Search-owned vocabulary for the installed Library-backed scoped Source capability. */
import type { Pool } from 'pg';
import type { CollectionAliasProgress, CollectionSource, CollectionSourceLimits, CollectionSourceObservation, CollectionSourceRawKey, NativeCollectionOrdinalPageBound, NativeSourceIdentity, PreparedCollectionSource, RawOrdinalCollectionPrefix, NativeOrdinalFrontier, NativeOrdinalKey, WorkAllowance, WorkReceipt } from '../library/contract/index.ts';
import type { CollectionSourceWorkState, MembersPreparationWorkContext, MembersPreparationWorkDefinition, NativeCollectionWork, PreparationLocator, ScopeWorkContext } from '../library/adapters/index.ts';
import type { Access } from '../request/access.ts';
/** Native source locator only. It does not grant authority or define a public Search sort. */
export type SearchScopeOrder = Readonly<{
    kind: 'id';
    source?: NativeSourceIdentity;
}> | Readonly<{
    kind: 'ordinal';
    source: NativeSourceIdentity;
}>;
export type SearchScopeOrdinalPrefix = Readonly<{
    subjects: readonly Readonly<{
        subject: string;
        after: NativeOrdinalKey;
    }>[];
    frontier: NativeOrdinalFrontier;
    exhausted: boolean;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export type SearchScopeCollection = Readonly<{
    order: SearchScopeOrder;
    source: PreparedCollectionSource;
    observation: CollectionSourceObservation;
}>;
export type SearchCollectionSourceDeps = Readonly<{
    pool: Pool;
    access: Access;
    clock?: () => Date;
}>;
export type SearchScopeWorkOptions = Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>;
export type SearchScopeWorkDefinition = Readonly<{
    sourceIdentity: NativeSourceIdentity;
    observation: CollectionSourceObservation;
    definition: Readonly<{
        sort: 'id' | 'ordinal';
    }>;
}>;
/** The complete Library capability used by one scoped Search application. */
export type SearchLibraryScopePort = Readonly<{
    source: Readonly<{
        open: (deps: SearchCollectionSourceDeps) => CollectionSource;
        readWorkState: (pool: Pool, work: ScopeWorkContext, options: SearchScopeWorkOptions) => Promise<CollectionSourceWorkState>;
        readWorkGroup: (work: ScopeWorkContext, state: CollectionSourceWorkState, subjectId: string, after: CollectionSourceRawKey | null, limit: number, options: Readonly<{
            deadline: number;
        }>) => Promise<Readonly<{
            rows: readonly Readonly<{
                key: CollectionSourceRawKey;
            }>[];
            exhausted: boolean;
            work: WorkReceipt;
        }>>;
        limits: CollectionSourceLimits;
    }>;
    members: Readonly<{
        createWork: (allowance: WorkAllowance, deadline: number) => NativeCollectionWork;
        readWorkDefinition: (work: MembersPreparationWorkContext, options: SearchScopeWorkOptions) => Promise<MembersPreparationWorkDefinition | null>;
    }>;
}>;
export type SearchNativeCollectionWork = NativeCollectionWork;
export type { CollectionAliasProgress, MembersPreparationWorkDefinition, NativeOrdinalFrontier, NativeOrdinalKey, PreparationLocator, RawOrdinalCollectionPrefix, CollectionSourceWorkState, NativeCollectionOrdinalPageBound, };
