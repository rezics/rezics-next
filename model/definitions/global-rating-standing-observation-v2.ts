import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const globalRatingStandingObservationDeclaration = {
  id: 'global-rating-standing-observation-v2',
  canonical: {
    observation: { types: ['rv:ScaledGlobalRatingObservation'] },
    revision: { types: ['rv:ScaledGlobalRatingObservationRevision'] },
  },
  binding: {
    required: ['context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:ScaledGlobalRatingObservation', 'rv:ScaledGlobalRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
