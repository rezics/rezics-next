import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { PublicFilterConsumerUnavailable, PublicFilterConsumerContext } from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';
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
