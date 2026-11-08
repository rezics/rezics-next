/** Concrete Collection Source operations for scoped Search. Bound at composition, never at module load. */
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import { NativeCollectionWork } from '../collection-native-work.ts';
import { readCollectionSourceWorkGroup } from '../collection-source-work-native.ts';
import type { MembersPreparationWorkDefinition } from '../members-preparation.ts';
import type { CollectionSource, CollectionSourceLimits, CollectionSourceRawKey, WorkAllowance } from '../contract/index.ts';
import type { MembersPreparationWorkContext, ScopeWorkContext } from './preparation-work.ts';
import type { CollectionSourceWorkState } from '../collection-source-work-native.ts';
export type ScopedCollectionSourceDeps = Readonly<{
    pool: Pool;
    access: Access;
    clock?: () => Date;
}>;
export type ScopedCollectionSourceWorkGroup = Awaited<ReturnType<typeof readCollectionSourceWorkGroup>>;
export type ScopedSearchLibraryOperations = Readonly<{
    source: Readonly<{
        open: (deps: ScopedCollectionSourceDeps) => CollectionSource;
        readWorkState: (pool: Pool, work: ScopeWorkContext, options: Readonly<{
            access: Access;
            deadline: number;
        }>) => Promise<CollectionSourceWorkState>;
        readWorkGroup: (work: ScopeWorkContext, state: CollectionSourceWorkState, subjectId: string, after: CollectionSourceRawKey | null, limit: number, options: Readonly<{
            deadline: number;
        }>) => Promise<ScopedCollectionSourceWorkGroup>;
        limits: CollectionSourceLimits;
    }>;
    members: Readonly<{
        createWork: (allowance: WorkAllowance, deadline: number) => NativeCollectionWork;
        readWorkDefinition: (work: MembersPreparationWorkContext, options: Readonly<{
            pool: Pool;
            access: Access;
            deadline: number;
        }>) => Promise<MembersPreparationWorkDefinition | null>;
    }>;
}>;
/** Construct native Source, Members getter, limits and receiving costs for one Search application. */
export declare function createScopedSearchLibraryOperations(): ScopedSearchLibraryOperations;
export type { CollectionSourceWorkState };
export type { CollectionSourceRawKey };
