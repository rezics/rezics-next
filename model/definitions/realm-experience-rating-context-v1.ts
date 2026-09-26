import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmStandingRatingContextProfile } from './realm-standing-rating-context-v1.ts';

/** A separate artifact: the standing profile and its digest remain immutable. */
export const realmExperienceRatingContextProfile = {
  ...realmStandingRatingContextProfile,
  id: 'realm-experience-rating-context-v1',
  comments: ['One immutable Realm question for intentional experience occasions.'],
  shapes: realmStandingRatingContextProfile.shapes.map(shape => ({
    ...shape,
    iri: shape.iri.replace('realm-standing-', 'realm-experience-'),
    properties: [
      ...shape.properties.map(property => property.path === 'rv:ratingCadence'
        ? { ...property, hasValue: '<https://rezics.com/definition/rating-experience-v1>' as const }
        : property),
      ...(shape.iri.endsWith('/context-shape') ? [
        { path: 'rdf:type' as const, hasValue: 'rv:ExperienceRatingContext' as const },
        { path: 'rv:ratingTimeZone' as const, maxCount: 0 },
        { path: 'rv:ratingCalendar' as const, maxCount: 0 },
      ] : []),
    ],
  })),
} satisfies ProfileDefinition;
