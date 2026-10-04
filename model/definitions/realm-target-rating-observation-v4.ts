import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmTargetRatingObservationProfile } from './realm-target-rating-observation-v1.ts';
import { realmTargetRatingContextV4Profile } from './realm-target-rating-context-v4.ts';

export const realmTargetRatingObservationV4Profile = {
  ...realmTargetRatingObservationProfile,
  id: 'realm-target-rating-observation-v4',
  comments: ['Exact-target standing observations for accepted Realm or Global questions.'],
  shapes: [
    ...realmTargetRatingContextV4Profile.shapes.map((shape) => ({
      ...shape,
      canonical: undefined,
      iri: shape.iri.replace('rating-context-', 'rating-observation-'),
    })),
    ...realmTargetRatingObservationProfile.shapes
      .filter(
        (shape) =>
          shape.iri.endsWith('/observation-shape') || shape.iri.endsWith('/revision-shape'),
      )
      .map((shape) => {
        const type = shape.iri.endsWith('/observation-shape')
          ? 'rv:AcceptedTargetRatingObservation'
          : 'rv:AcceptedTargetRatingObservationRevision';
        return {
          ...shape,
          iri: shape.iri.replace('-v1/', '-v4/'),
          canonical: { types: [type] as const },
          properties: [...shape.properties, { path: 'rdf:type' as const, hasValue: type }],
        };
      }),
  ],
  binding: {
    ...realmTargetRatingObservationProfile.binding,
    demandedBy: [
      'rv:AcceptedTargetRatingObservation',
      'rv:AcceptedTargetRatingObservationRevision',
    ],
  },
} satisfies ProfileDefinition;
