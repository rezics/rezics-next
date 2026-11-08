import { type DiscoveryFilterDocument, type SpoilerThreshold } from '@rezics/filter';
import { type IndexedSubject, type SubjectSource } from './source.ts';
import { type CurrentRelationRelease } from './disclosure/check.ts';
export { matchInverseRelationFacets, withCurrentRelationRelease, type CurrentRelationRelease, type InverseRelationFacetProbe, } from './disclosure/check.ts';
import type { CharacterPersonDiscoveryContexts } from './discovery.ts';
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
