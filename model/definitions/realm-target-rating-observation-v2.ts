import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingObservationV2Declaration = {
  id: 'realm-target-rating-observation-v2',
  canonical: {
    observation: {
      types: ['rv:LanguageTaggedTargetRatingObservation'],
    },
    revision: {
      types: ['rv:LanguageTaggedTargetRatingObservationRevision'],
    },
  },
  binding: {
    required: ['realm', 'context', 'target', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'observation', 'revision'],
    demandedBy: ['rv:LanguageTaggedTargetRatingObservation', 'rv:LanguageTaggedTargetRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
