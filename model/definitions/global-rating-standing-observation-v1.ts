import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const globalRatingStandingObservationDeclaration = {
  id: 'global-rating-standing-observation-v1',
  canonical: {
    observation: { types: ['rv:GlobalRatingObservation'] },
    revision: { types: ['rv:GlobalRatingObservationRevision'] },
  },
  binding: {
    required: ['context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:GlobalRatingObservation', 'rv:GlobalRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
