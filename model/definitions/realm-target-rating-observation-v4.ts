import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingObservationV4Declaration = {
  id: 'realm-target-rating-observation-v4',
  canonical: {
    observation: {
      types: ['rv:AcceptedTargetRatingObservation'],
    },
    revision: {
      types: ['rv:AcceptedTargetRatingObservationRevision'],
    },
  },
  binding: {
    required: ['realm', 'context', 'target', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'observation', 'revision'],
    demandedBy: ['rv:AcceptedTargetRatingObservation', 'rv:AcceptedTargetRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
