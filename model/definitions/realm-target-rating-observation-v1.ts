import type { ProfileDefinition } from '../compiler/ir.ts';
import { readFileSync } from 'node:fs';
import { parseTurtleProfile } from '../compiler/shacl.ts';

const realmStandingRatingObservationProfile = parseTurtleProfile('realm-standing-rating-observation-v1',
  readFileSync(new URL('./realm-standing-rating-observation-v1.ttl', import.meta.url), 'utf8'));
import { realmTargetRatingContextProfile } from './realm-target-rating-context-v1.ts';

const required = (path: `rv:${string}`, term: `rv:${string}`) =>
  ({ path, minCount: 1, maxCount: 1, class: term });
/** Target ownership and grain are proved by G-506, never a descriptive SHACL class. */
export const realmTargetRatingObservationProfile = {
  ...realmStandingRatingObservationProfile,
  id: 'realm-target-rating-observation-v1',
  comments: ['One opaque Account-principal standing slot for an exact target and Realm question.'],
  shapes: [
    ...realmTargetRatingContextProfile.shapes.map(shape => ({ ...shape, canonical: undefined,
      iri: shape.iri.replace('rating-context-', 'rating-observation-') })),
    { iri: 'https://rezics.com/definition/realm-target-rating-observation-v1/observation-shape',
      canonical: { types: ['rv:TargetRatingObservation'] as const }, properties: [
        { path: 'rdf:type', hasValue: 'rv:TargetRatingObservation' },
        required('rv:ratingContext', 'rv:TargetRatingContext'),
        { path: 'rv:target', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:ratingSlot', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        required('rv:observationHead', 'rv:TargetRatingObservationRevision'),
        { path: 'rv:targetMainVersion', maxCount: 0 }, { path: 'rv:targetRelease', maxCount: 0 },
      ] },
    ...realmStandingRatingObservationProfile.shapes.filter(shape => shape.iri.endsWith('/revision-shape'))
      .map(shape => ({ ...shape, iri: shape.iri.replace('realm-standing-', 'realm-target-'),
        canonical: { types: ['rv:TargetRatingObservationRevision'] as const },
        properties: shape.properties.map(property => property.path === 'rdf:type'
          ? { ...property, hasValue: 'rv:TargetRatingObservationRevision' as const }
          : property.path === 'rv:observation' ? required('rv:observation', 'rv:TargetRatingObservation')
            : property.path === 'rv:predecessor'
              ? { ...property, class: 'rv:TargetRatingObservationRevision' as const } : property) })),
  ],
  binding: { required: ['realm', 'context', 'target', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'], roles: ['realm', 'context', 'observation', 'revision'],
    demandedBy: ['rv:TargetRatingObservation', 'rv:TargetRatingObservationRevision'] },
} satisfies ProfileDefinition;
