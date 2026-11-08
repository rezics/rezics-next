import { type FilterDocument, type FilterQualifier, type SpoilerThreshold, type FilterRelease } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import { type ConceptFilterExecution } from '../concept-browse-statements.ts';
import { type IndexedSubject, type RelationFacetMatch, type SubjectSource } from '../source.ts';
import type { Hit, FactClause } from './admission.ts';
export type { Hit, FactClause } from './admission.ts';
/** An inverse edge from a selected work to the candidate Character or Person. */
export type InverseRelationFacetProbe = {
    subject: string;
    source: string;
    property: string;
    qualifiers?: readonly FilterQualifier[];
    spoilerThreshold?: SpoilerThreshold;
};
export type CurrentRelationRelease = {
    digest: string;
    head: number;
    release: FilterRelease;
    definitions?: Release;
};
/** No release permission survives foreign disclosure I/O. Missing/replaced releases withhold the window. */
export declare function withCurrentRelationRelease<T>(observe: () => Promise<CurrentRelationRelease | null>, work: (release: FilterRelease, pin: CurrentRelationRelease) => Promise<T>, unavailable: T): Promise<T>;
/**
 * Execute inverse membership through the existing selected-value seek and same-statement matcher.
 * The selected source ids bound work independently of actor degree. No inbound sample, pooled
 * qualifiers, or second Boolean interpreter is introduced. This step is a witness search;
 * an undisclosed or exhausted forward window cannot certify an inverse negative.
 */
export declare function matchInverseRelationFacets(source: SubjectSource, partition: number, probes: readonly InverseRelationFacetProbe[], observe: () => Promise<CurrentRelationRelease | null>): Promise<RelationFacetMatch[]>;
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
