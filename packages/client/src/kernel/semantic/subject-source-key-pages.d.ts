import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { PublicFilterConsumerUnavailable, PublicFilterConsumerContext } from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';
export type SubjectCanonicalHome = Readonly<{
    partition: number;
    generation: string;
    epoch: number;
    position: string;
}>;
export type SubjectCanonicalPopulation = Readonly<{
    generation: string;
    homes: readonly SubjectCanonicalHome[];
}>;
export type SubjectCanonicalNameKey = Readonly<{
    name: string | null;
    id: string;
}>;
/** Internal canonical candidates, before Subject disclosure. Never a public read grant. */
export interface SubjectCanonicalNames {
    observe(context: {
        deadline: number;
    }): Promise<SubjectCanonicalPopulation>;
    read(request: Readonly<{
        partition: number;
        after: SubjectCanonicalNameKey | null;
        limit: number;
    }>, expected: SubjectCanonicalPopulation, context: {
        deadline: number;
    }): Promise<Readonly<{
        home: SubjectCanonicalHome;
        candidates: readonly (SubjectCanonicalNameKey & Readonly<{
            securityRevision: number;
        }>)[];
    }>>;
}
/** Current native name order, separate from the fixed-cut ID-key rebuild inventory below.
 * The finite frontier reads occupied native homes, never every partition's Subject rows.
 * A committed per-home generation avoids treating an uncommitted sequence increment as publication.
 */
export declare function createSubjectCanonicalNames(pool: Pool): SubjectCanonicalNames;
/** Agreed background-only additive capability on subjectSource; never exposed to request capture. */
export interface SubjectSourceKeyTraversal {
    readSubjectKeyPage(request: Readonly<{
        partition: number;
        epoch: number;
        after: Readonly<{
            route: number;
            id: string;
        }> | null;
        through: bigint;
        inputLimit: number;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'progress' | 'complete';
        partition: number;
        epoch: number;
        through: bigint;
        keys: readonly string[];
        after: Readonly<{
            route: number;
            id: string;
        }> | null;
        position: bigint;
        cost: PublicFilterCost;
    }> | Readonly<{
        status: 'changed' | 'gap';
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
}
/** PROVISIONAL Semantic producer adapter. No unavailable owner becomes a complete empty page. */
export declare const readSubjectKeyPage: SubjectSourceKeyTraversal['readSubjectKeyPage'];
export type SubjectSourceKeyCursor = Readonly<{
    route: number;
    id: string;
}>;
export type SubjectSourceKeyPage = Readonly<{
    status: 'eligible';
    partition: number;
    epoch: number;
    position: bigint;
    ids: readonly string[];
    after: SubjectSourceKeyCursor | null;
    complete: boolean;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'identity_pending';
    partition: number;
    epoch: number;
    position: bigint;
    after: SubjectSourceKeyCursor | null;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'unavailable';
    reason: 'missing_owner' | 'moved' | 'deadline' | 'metadata_missing';
    cost: PublicFilterCost;
}>;
export interface SubjectSourceKeyPages {
    read(request: Readonly<{
        partition: number;
        after: SubjectSourceKeyCursor | null;
        inputLimit: number;
    }>, context: PublicFilterConsumerContext): Promise<SubjectSourceKeyPage>;
}
/** Search's older prepared-index continuation carries a fixed source cut and is a separate owner port. */
export type SubjectSourceKeyPageWorkerRequest = Readonly<{
    partition: number;
    epoch: number;
    after: SubjectSourceKeyCursor | null;
    through: bigint;
    inputLimit: number;
}>;
export type SubjectSourceKeyPageWorkerResult = Readonly<{
    status: 'progress' | 'complete' | 'unavailable';
    partition: number;
    epoch: number;
    through: bigint;
    position: bigint;
    keys: readonly string[];
    after: SubjectSourceKeyCursor | null;
    cost: PublicFilterCost;
}>;
export interface SubjectSourceKeyPageWorker {
    readSubjectKeyPage(request: SubjectSourceKeyPageWorkerRequest, context: PublicFilterConsumerContext): Promise<SubjectSourceKeyPageWorkerResult>;
}
/** Missing fixed-cut bridge stays pending; a current page cannot certify an older rebuild cut. */
export declare function pendingSubjectSourceKeyPage(request: SubjectSourceKeyPageWorkerRequest): SubjectSourceKeyPageWorkerResult;
/** Internal rebuild inventory. Never used for request-time privacy observation or disclosure. */
export declare function createSubjectSourceKeyPages(pool: Pool, routing: Uint8Array, access: Access): SubjectSourceKeyPages;
export type FacetPopulationSubjectSourceKeyPages = SubjectSourceKeyPages;
