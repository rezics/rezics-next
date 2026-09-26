import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmStandingRatingObservationProfile } from './realm-standing-rating-observation-v1.ts';

export const realmExperienceRatingObservationProfile = {
  ...realmStandingRatingObservationProfile,
  id: 'realm-experience-rating-observation-v1',
  comments: ['A private-principal, Context and MainVersion slot for one intentional occasion.',
    'Only an opaque server-derived occasion reference is stored in RDF.'],
  shapes: realmStandingRatingObservationProfile.shapes.map(shape => {
    const role = shape.iri.split('/').at(-1);
    const type = role === 'context-shape' ? 'rv:ExperienceRatingContext'
      : role === 'observation-shape' ? 'rv:ExperienceRatingObservation'
      : role === 'revision-shape' ? 'rv:ExperienceRatingObservationRevision' : undefined;
    return { ...shape,
      iri: shape.iri.replace('realm-standing-', 'realm-experience-'),
      properties: [
        ...shape.properties.map(property => property.path === 'rv:ratingCadence'
          ? { ...property, hasValue: '<https://rezics.com/definition/rating-experience-v1>' as const }
          : property),
        ...(type ? [{ path: 'rdf:type' as const, hasValue: type }] : []),
        ...(role === 'observation-shape' || role === 'revision-shape' ? [{
          path: 'rv:ratingOccasion' as const, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const,
          pattern: '^urn:rezics:rating-occasion:[0-9a-f]{64}$',
        }] : []),
        ...(type ? (['rv:ratingDay', 'rv:ratingTimeZone', 'rv:ratingCalendar',
          'rv:periodStart', 'rv:periodEnd'] as const).map(path => ({ path, maxCount: 0 })) : []),
      ],
    };
  }),
} satisfies ProfileDefinition;
