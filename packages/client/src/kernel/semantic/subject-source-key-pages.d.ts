import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable } from '../search/public-filter-consumer-contract.ts';
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
/** Factory-owned population reader; the existing subjectSource capability stays unchanged. */
export interface SubjectSourceKeyPages {
    read(request: Readonly<{
        partition: number;
        after: SubjectSourceKeyCursor | null;
        inputLimit: number;
    }>, context: PublicFilterConsumerContext): Promise<SubjectSourceKeyPage>;
}
/** PROVISIONAL agreed producer adapter; absence is never authoritative native emptiness. */
export declare function createSubjectSourceKeyPages(_pool: Pool, _routing: Uint8Array, _access: Access): SubjectSourceKeyPages;
/** Compatibility name for the existing facet population factory consumer. */
export type FacetPopulationSubjectSourceKeyPages = SubjectSourceKeyPages;
