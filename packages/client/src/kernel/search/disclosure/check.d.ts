import type { FilterDocument, FilterQualifier, FilterRange } from '@rezics/filter';
import { type IndexedSubject, type SubjectSource } from '../source.ts';
/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = {
    id: string;
    partition: number;
    securityRevision: number;
    matched: readonly string[];
};
/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause = {
    facet: 'type';
    values: readonly string[];
} | ({
    facet: 'statement';
    property: string;
    qualifiers?: readonly FilterQualifier[];
} & ({
    values: readonly string[];
} | {
    range: FilterRange;
}));
/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export declare function checkHits(source: SubjectSource, hits: readonly Hit[], clauses: ReadonlyMap<string, FactClause>, options?: {
    concurrency?: number;
    filter?: FilterDocument;
    relationProperties?: readonly string[];
}): Promise<{
    passed: {
        hit: Hit;
        subject: IndexedSubject;
    }[];
    dropped: number;
    relationRejected?: true;
}>;
