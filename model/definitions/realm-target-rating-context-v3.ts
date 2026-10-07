import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingContextV3Declaration = {
  id: 'realm-target-rating-context-v3',
  canonical: {
    context: {
      types: ['rv:ScopedTargetRatingContext'],
    },
  },
  binding: {
    required: ['realm', 'context', 'question', 'language', 'grain'],
    optional: ['displayThreshold'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:ScopedTargetRatingContext'],
  },
} as const satisfies TurtleDeclaration;
