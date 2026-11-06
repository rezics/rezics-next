import { type CurrentRelationRelease } from '../character-person.ts';
import type { ConceptSelection, FilterDocument, FilterQualifier, FilterRange, SpoilerThreshold } from '@rezics/filter';
import type { ConceptFilterExecution } from '../concept-browse-statements.ts';
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
} | {
    facet: 'statement';
    property: string;
    qualifiers?: readonly FilterQualifier[];
    values: readonly string[];
    concept?: ConceptSelection;
    inverse?: true;
} | {
    facet: 'statement';
    property: string;
    qualifiers?: readonly FilterQualifier[];
    range: FilterRange;
};
/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export declare function checkHits<NativeHit extends Hit>(source: SubjectSource, hits: readonly NativeHit[], clauses: ReadonlyMap<string, FactClause>, options?: {
    concurrency?: number;
    filter?: FilterDocument;
    relationProperties?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease?: () => Promise<CurrentRelationRelease | null>;
    conceptFilter?: ConceptFilterExecution;
    /** Re-evaluate a stale indexed text hint against the current native Subject projection. */
    currentText?: (subject: IndexedSubject) => Promise<boolean>;
}): Promise<{
    passed: {
        hit: NativeHit;
        subject: IndexedSubject;
    }[];
    dropped: number;
    relationRejected?: true;
}>;
