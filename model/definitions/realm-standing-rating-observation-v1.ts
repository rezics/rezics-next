import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmStandingRatingObservationDeclaration = {
  id: 'realm-standing-rating-observation-v1',
  canonical: {
    observation: { types: ['rv:RatingObservation'] },
    revision: { types: ['rv:RatingObservationRevision'] },
  },
  binding: {
    required: ['realm', 'context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:RatingObservation', 'rv:RatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
