import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmTargetRatingContextV2Profile } from './realm-target-rating-context-v2.ts';

/** The scoped type replaces v2's language-tagged type, so a v3 Context routes to
 * this shape alone and v1/v2 Contexts keep their accepted shapes. The threshold
 * is optional: its absence selects the grain's default at read time. */
export const realmTargetRatingContextV3Profile = {
  ...realmTargetRatingContextV2Profile,
  id: 'realm-target-rating-context-v3',
  comments: ['An exact-target Realm question that may name a projection grain and its own display threshold.'],
  shapes: realmTargetRatingContextV2Profile.shapes.map(shape => ({
    ...shape, iri: shape.iri.replace('-v2/', '-v3/'),
    ...(shape.iri.endsWith('/context-shape') ? {
      canonical: { types: ['rv:ScopedTargetRatingContext'] as const },
      properties: [...shape.properties.filter(property => property.hasValue !== 'rv:LanguageTaggedTargetRatingContext')
        .map(property => property.path === 'rv:targetGrain'
          ? { ...property, in: [...property.in!, 'rv:Projection' as const] } : property),
      { path: 'rdf:type' as const, hasValue: 'rv:ScopedTargetRatingContext' as const },
      { path: 'rv:displayThreshold' as const, maxCount: 1, datatype: 'xsd:integer' as const,
        minInclusive: 1, maxInclusive: 1000 }],
    } : {}),
  })),
  binding: { required: ['realm', 'context', 'question', 'language', 'grain'], optional: ['displayThreshold'],
    roles: ['realm', 'context'], demandedBy: ['rv:ScopedTargetRatingContext'] },
} satisfies ProfileDefinition;
