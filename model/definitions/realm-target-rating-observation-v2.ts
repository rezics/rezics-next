import type { ProfileDefinition, Term } from '../compiler/ir.ts';
import { readFileSync } from 'node:fs';
import { parseTurtleProfile } from '../compiler/shacl.ts';
import { realmTargetRatingObservationDeclaration } from './realm-target-rating-observation-v1.ts';
import { realmTargetRatingContextV2Profile } from './realm-target-rating-context-v2.ts';

const realmTargetRatingObservationProfile = parseTurtleProfile('realm-target-rating-observation-v1',
  readFileSync(new URL('./realm-target-rating-observation-v1.ttl', import.meta.url), 'utf8'),
  realmTargetRatingObservationDeclaration);

export const realmTargetRatingObservationV2Profile = {
  ...realmTargetRatingObservationProfile,
  id: 'realm-target-rating-observation-v2',
  comments: ['Exact-target standing observations for language-tagged Realm questions.'],
  shapes: [
    ...realmTargetRatingContextV2Profile.shapes.map(shape => ({ ...shape, canonical: undefined,
      iri: shape.iri.replace('rating-context-', 'rating-observation-') })),
    ...realmTargetRatingObservationProfile.shapes.filter(shape =>
      shape.iri.endsWith('/observation-shape') || shape.iri.endsWith('/revision-shape')).map(shape => {
      const type: Term = shape.iri.endsWith('/observation-shape')
        ? 'rv:LanguageTaggedTargetRatingObservation' : 'rv:LanguageTaggedTargetRatingObservationRevision';
      return { ...shape, iri: shape.iri.replace('-v1/', '-v2/'),
        canonical: { types: [type] as const },
        properties: [...shape.properties, { path: 'rdf:type' as const, hasValue: type }] };
    }),
  ],
  binding: { ...realmTargetRatingObservationDeclaration.binding,
    demandedBy: ['rv:LanguageTaggedTargetRatingObservation', 'rv:LanguageTaggedTargetRatingObservationRevision'] },
} satisfies ProfileDefinition;
