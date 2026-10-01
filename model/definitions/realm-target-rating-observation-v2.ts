import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmTargetRatingObservationProfile } from './realm-target-rating-observation-v1.ts';
import { realmTargetRatingContextV2Profile } from './realm-target-rating-context-v2.ts';

export const realmTargetRatingObservationV2Profile = {
  ...realmTargetRatingObservationProfile,
  id: 'realm-target-rating-observation-v2',
  comments: ['Exact-target standing observations for language-tagged Realm questions.'],
  shapes: [
    ...realmTargetRatingContextV2Profile.shapes.map(shape => ({ ...shape, canonical: undefined,
      iri: shape.iri.replace('rating-context-', 'rating-observation-') })),
    ...realmTargetRatingObservationProfile.shapes.filter(shape =>
      shape.iri.endsWith('/observation-shape') || shape.iri.endsWith('/revision-shape')).map(shape => {
      const type = shape.iri.endsWith('/observation-shape')
        ? 'rv:LanguageTaggedTargetRatingObservation' : 'rv:LanguageTaggedTargetRatingObservationRevision';
      return { ...shape, iri: shape.iri.replace('-v1/', '-v2/'),
        canonical: { types: [type] as const },
        properties: [...shape.properties, { path: 'rdf:type' as const, hasValue: type }] };
    }),
  ],
  binding: { ...realmTargetRatingObservationProfile.binding,
    demandedBy: ['rv:LanguageTaggedTargetRatingObservation', 'rv:LanguageTaggedTargetRatingObservationRevision'] },
} satisfies ProfileDefinition;
