import type { ProfileDefinition, PropertyDefinition, ShapeDefinition } from '../compiler/ir.ts';
import { readFileSync } from 'node:fs';
import { parseTurtleProfile } from '../compiler/shacl.ts';

const realmStandingRatingObservationProfile = parseTurtleProfile('realm-standing-rating-observation-v1',
  readFileSync(new URL('./realm-standing-rating-observation-v1.ttl', import.meta.url), 'utf8'));

const iri = (role: string) => `https://rezics.com/definition/realm-release-rating-observation-v1/${role}-shape`;
const requiredClass = (path: `rv:${string}`, term: `rv:${string}` | `schema:${string}`) => ({
  path, minCount: 1, maxCount: 1, class: term, lineBreaks: [{ after: 3, indent: 8 }] });
const absent = (paths: readonly `rv:${string}`[]): PropertyDefinition[] =>
  paths.map(path => ({ path, maxCount: 0 }));
const foreignCadence = ['rv:ratingOccasion', 'rv:ratingDay', 'rv:ratingTimeZone', 'rv:ratingCalendar',
  'rv:periodStart', 'rv:periodEnd'] as const;

/**
 * One Account-principal standing slot for one exact FixedRelease. The release
 * names its MainVersion, but the observation never targets that MainVersion.
 */
export const realmReleaseRatingObservationProfile = {
  ...realmStandingRatingObservationProfile,
  id: 'realm-release-rating-observation-v1',
  comments: ['One Account-principal standing slot for one exact FixedRelease and Realm question.',
    'The slot is opaque; the release target never counts toward its MainVersion.'],
  shapes: realmStandingRatingObservationProfile.shapes.flatMap((shape): ShapeDefinition[] => {
    const role = shape.iri.split('/').at(-1);
    const renamed = { ...shape, iri: shape.iri.replace('realm-standing-', 'realm-release-') };
    if (role === 'context-shape') {
      return [{ ...renamed, properties: [
        ...shape.properties.map(property => property.path === 'rdf:type'
          ? { ...property, hasValue: 'rv:ReleaseRatingContext' as const }
          : property.path === 'rv:targetGrain' ? { ...property, hasValue: 'rv:FixedRelease' as const }
          : property.path === 'rv:realm' ? { ...property, class: 'rv:Realm' as const } : property),
      ] }];
    }
    if (role === 'main-shape') {
      return [renamed, { iri: iri('release'), properties: [
        { path: 'rdf:type', hasValue: 'rv:FixedRelease' },
        requiredClass('rv:work', 'schema:CreativeWork'),
        requiredClass('rv:mainVersion', 'rv:MainVersion'),
      ] }];
    }
    if (role === 'observation-shape') {
      return [{ ...renamed, canonical: { types: ['rv:ReleaseRatingObservation'] }, properties: [
        { path: 'rdf:type', hasValue: 'rv:ReleaseRatingObservation' },
        requiredClass('rv:ratingContext', 'rv:ReleaseRatingContext'),
        requiredClass('rv:targetRelease', 'rv:FixedRelease'),
        ...shape.properties.filter(property => ['rv:ratingSlot', 'rv:observationHead'].includes(property.path))
          .map(property => property.path === 'rv:observationHead'
            ? requiredClass('rv:observationHead', 'rv:ReleaseRatingObservationRevision') : property),
        ...absent(['rv:targetMainVersion', ...foreignCadence]),
      ] }];
    }
    if (role === 'revision-shape') {
      return [{ ...renamed, canonical: { types: ['rv:ReleaseRatingObservationRevision'] }, properties: [
        { path: 'rdf:type', hasValue: 'rv:ReleaseRatingObservationRevision' },
        requiredClass('rv:observation', 'rv:ReleaseRatingObservation'),
        ...shape.properties.filter(property => property.path !== 'rdf:type' && property.path !== 'rv:observation')
          .map(property => property.path === 'rv:predecessor'
            ? { ...property, class: 'rv:ReleaseRatingObservationRevision' as const } : property),
        ...absent(foreignCadence),
      ] }];
    }
    return [renamed];
  }),
  binding: { required: ['realm', 'context', 'work', 'main', 'release', 'slot', 'observation', 'revision',
    'availability'], optional: ['value', 'predecessor'],
  roles: ['realm', 'context', 'work', 'main', 'release', 'observation', 'revision'],
  demandedBy: ['rv:ReleaseRatingObservation', 'rv:ReleaseRatingObservationRevision'] },
} satisfies ProfileDefinition;
