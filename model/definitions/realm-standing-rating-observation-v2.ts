import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmStandingRatingObservationDeclaration = {
  id: 'realm-standing-rating-observation-v2',
  canonical: {
    observation: { types: ['rv:ScaledRatingObservation'] },
    revision: { types: ['rv:ScaledRatingObservationRevision'] },
  },
  binding: {
    required: ['realm', 'context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:ScaledRatingObservation', 'rv:ScaledRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
