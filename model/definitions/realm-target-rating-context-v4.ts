import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmTargetRatingContextV3Profile } from './realm-target-rating-context-v3.ts';

/** Accepted types are alternatives; accepted dimensions permit every coordinate
 * in a projection. Omission leaves that selection unrestricted. Global uses
 * the same question and scale as a Realm, with its own population owner. */
export const realmTargetRatingContextV4Profile = {
  ...realmTargetRatingContextV3Profile,
  id: 'realm-target-rating-context-v4',
  comments: [
    'An exact-target question with optional subject types and projection frame dimensions, owned by a Realm or Global.',
  ],
  shapes: realmTargetRatingContextV3Profile.shapes.map((shape) => ({
    ...shape,
    iri: shape.iri.replace('-v3/', '-v4/'),
    ...(shape.iri.endsWith('/realm-shape')
      ? {
          canonical: { types: ['rv:GlobalRatingPopulation'] as const },
          properties: shape.properties.filter((property) => property.path === 'rv:ratingContext'),
          or: [
            [
              { path: 'rdf:type' as const, hasValue: 'rv:Realm' as const },
              { path: 'rv:realmState' as const, hasValue: 'rv:Active' as const, maxCount: 1 },
            ],
            [{ path: 'rdf:type' as const, hasValue: 'rv:GlobalRatingPopulation' as const }],
          ],
        }
      : {}),
    ...(shape.iri.endsWith('/context-shape')
      ? {
          canonical: { types: ['rv:AcceptedTargetRatingContext'] as const },
          properties: [
            ...shape.properties.filter(
              (property) => property.hasValue !== 'rv:ScopedTargetRatingContext',
            ),
            { path: 'rdf:type' as const, hasValue: 'rv:AcceptedTargetRatingContext' as const },
            { path: 'rv:acceptedSubjectType' as const, maxCount: 32, nodeKind: 'sh:IRI' as const },
            {
              path: 'rv:acceptedFrameDimension' as const,
              maxCount: 8,
              datatype: 'xsd:string' as const,
              in: [
                '"work"',
                '"realization"',
                '"release"',
                '"position"',
                '"event"',
                '"continuity"',
              ] as const,
            },
          ],
        }
      : {}),
  })),
  binding: {
    ...realmTargetRatingContextV3Profile.binding,
    demandedBy: ['rv:AcceptedTargetRatingContext'],
  },
} satisfies ProfileDefinition;
