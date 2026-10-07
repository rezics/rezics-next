import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingObservationDeclaration = {
  id: 'realm-target-rating-observation-v1',
  canonical: {
    observation: { types: ['rv:TargetRatingObservation'] },
    revision: { types: ['rv:TargetRatingObservationRevision'] },
  },
  binding: {
    required: ['realm', 'context', 'target', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'observation', 'revision'],
    demandedBy: ['rv:TargetRatingObservation', 'rv:TargetRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
