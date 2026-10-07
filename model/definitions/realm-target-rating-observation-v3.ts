import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingObservationV3Declaration = {
  id: 'realm-target-rating-observation-v3',
  canonical: {
    observation: {
      types: ['rv:ScopedTargetRatingObservation'],
    },
    revision: {
      types: ['rv:ScopedTargetRatingObservationRevision'],
    },
  },
  binding: {
    required: ['realm', 'context', 'target', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'observation', 'revision'],
    demandedBy: ['rv:ScopedTargetRatingObservation', 'rv:ScopedTargetRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
