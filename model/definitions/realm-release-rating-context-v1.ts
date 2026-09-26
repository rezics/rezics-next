import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmStandingRatingContextProfile } from './realm-standing-rating-context-v1.ts';

/** A separate grain: its own type keeps MainVersion routes and populations away. */
export const realmReleaseRatingContextProfile = {
  ...realmStandingRatingContextProfile,
  id: 'realm-release-rating-context-v1',
  comments: ['One Realm question about exact FixedRelease targets; one standing opinion per Account principal.',
    'It is never a MainVersion Context: no MainVersion population or aggregate reads it.'],
  shapes: realmStandingRatingContextProfile.shapes.map(shape => {
    const context = shape.iri.endsWith('/context-shape');
    return {
      ...shape,
      iri: shape.iri.replace('realm-standing-', 'realm-release-'),
      properties: [
        ...shape.properties.map(property => context && property.path === 'rdf:type'
          ? { ...property, hasValue: 'rv:ReleaseRatingContext' as const }
          : property.path === 'rv:targetGrain' ? { ...property, hasValue: 'rv:FixedRelease' as const }
          : property),
        ...(context ? (['rv:ratingTimeZone', 'rv:ratingCalendar', 'rv:ratingPolicyHead'] as const)
          .map(path => ({ path, maxCount: 0 })) : []),
      ],
      ...(context ? { canonical: { types: ['rv:ReleaseRatingContext'] as const } } : {}),
    };
  }),
  binding: { required: ['realm', 'context', 'question'], roles: ['realm', 'context'],
    demandedBy: ['rv:ReleaseRatingContext'] },
} satisfies ProfileDefinition;
