import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingContextV4Declaration = {
  id: 'realm-target-rating-context-v4',
  canonical: {
    realm: {
      types: ['rv:GlobalRatingPopulation'],
    },
    context: {
      types: ['rv:AcceptedTargetRatingContext'],
    },
  },
  binding: {
    required: ['realm', 'context', 'question', 'language', 'grain'],
    optional: ['displayThreshold'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:AcceptedTargetRatingContext'],
  },
} as const satisfies TurtleDeclaration;
