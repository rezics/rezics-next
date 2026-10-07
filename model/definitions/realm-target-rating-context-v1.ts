import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingContextDeclaration = {
  id: 'realm-target-rating-context-v1',
  canonical: { context: { types: ['rv:TargetRatingContext'] } },
  binding: {
    required: ['realm', 'context', 'question', 'grain'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:TargetRatingContext'],
  },
} as const satisfies TurtleDeclaration;
