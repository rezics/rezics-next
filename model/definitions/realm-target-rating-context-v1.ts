import type { ProfileDefinition } from '../compiler/ir.ts';
import { readFileSync } from 'node:fs';
import { parseTurtleProfile } from '../compiler/shacl.ts';

const realmStandingRatingContextProfile = parseTurtleProfile('realm-standing-rating-context-v1',
  readFileSync(new URL('./realm-standing-rating-context-v1.ttl', import.meta.url), 'utf8'));

/** One profile, with the owner-selected grain fixed for the life of each Context. */
export const realmTargetRatingContextProfile = {
  ...realmStandingRatingContextProfile,
  id: 'realm-target-rating-context-v1',
  comments: ['A Realm question about one exact release, realization, occurrence or resource.'],
  shapes: realmStandingRatingContextProfile.shapes.map(shape => ({
    ...shape, iri: shape.iri.replace('realm-standing-', 'realm-target-'),
    ...(shape.iri.endsWith('/context-shape') ? { canonical: { types: ['rv:TargetRatingContext'] as const } } : {}),
    properties: shape.properties.map(property => property.path === 'rv:targetGrain'
      ? { path: property.path, minCount: 1, maxCount: 1,
        in: ['rv:Release', 'rv:Realization', 'rv:Occurrence', 'rv:Resource'] as const }
      : property.path === 'rdf:type' && shape.iri.endsWith('/context-shape')
        ? { ...property, hasValue: 'rv:TargetRatingContext' as const } : property),
  })),
  binding: { required: ['realm', 'context', 'question', 'grain'], roles: ['realm', 'context'],
    demandedBy: ['rv:TargetRatingContext'] },
} satisfies ProfileDefinition;
