import type { Release } from '@rezics/definitions';
import type { RelationFacetMatch } from '../search/source.ts';
import { type LeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import type { PreparedCollectionSource } from './collection-source.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import type { OwnerFilterCandidateClosure, OwnerFilterReadBinding } from './owner-filter-plan.ts';
import { type CollectionMemberAdmission, type OwnerFilterFactLocator } from './owner-filter.ts';
export { OWNER_FILTER_CLOSURE_REFERENCE_LIMIT, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT } from './contract/index.ts';
/** Read the same raw native fact directory used by ordinary owner closure evaluation.
 * Search meters this query against its one admitted member-work reservation before calling the Library port.
 * Returning null preserves unknown closure evidence; this reader never turns an incomplete window into absence.
 */
export declare function readNativeOwnerFilterCandidateFacts(client: Pick<import('pg').PoolClient, 'query'>, input: Readonly<{
    route: number;
    accountId: string;
    subjectId: string;
    limit: number;
}>): Promise<readonly OwnerFilterFactLocator[] | null>;
/** Evaluate the complete native closure on the caller's snapshot and ledger. */
export declare function evaluateNativeOwnerFilterCandidate(client: Pick<import('pg').PoolClient, 'query'>, admission: CollectionMemberAdmission, closure: OwnerFilterCandidateClosure, work: NativeCollectionWork): Promise<RelationFacetMatch>;
/** A prepared answer must reauthorize its complete structural population, including exclusions/order.
 * LIMIT bounds raw references before hydration. A full window is unavailable, never fabricated coverage.
 */
export declare function retainNativeOwnerFilterPopulation(binding: OwnerFilterReadBinding, work: NativeCollectionWork): Promise<void>;
export declare function readNativeOwnerFilterClosure(binding: OwnerFilterReadBinding, source: PreparedCollectionSource, subjectId: string, work: NativeCollectionWork, deferDisclosure?: boolean): Promise<{
    readonly status: 'unavailable';
    readonly closure?: never;
} | {
    readonly status: 'complete';
    readonly closure: Readonly<{
        subjectId: string;
        originals: readonly Readonly<{
            subjectId: string;
            facts: readonly OwnerFilterFactLocator[];
        }>[];
        releases: ReadonlyMap<string, Release>;
        catalogue: ReadonlyMap<string, LeafEvidence>;
    }>;
}>;
