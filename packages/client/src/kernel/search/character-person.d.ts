import { type DiscoveryFilterDocument, type FilterQualifier, type FilterRelease, type SpoilerThreshold } from '@rezics/filter';
import { type IndexedSubject, type RelationFacetMatch, type SubjectSource } from './source.ts';
import type { CharacterPersonDiscoveryContexts } from './discovery.ts';
import { type Release } from '@rezics/definitions';
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
/**
 * Project only source works named by admitted inverse leaves. The inverse matcher is the same
 * current statement and release-fenced path used for membership; a context link is never inferred
 * from an index sample or from a different credit.
 */
export declare function projectCharacterPersonContexts(source: SubjectSource, subject: Pick<IndexedSubject, 'id' | 'type'>, filter: DiscoveryFilterDocument | undefined, options: {
    languages?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease: () => Promise<CurrentRelationRelease | null>;
}): Promise<CharacterPersonDiscoveryContexts | null>;
export declare const CHARACTER_PERSON_CONTEXT_LIMIT = 3;
