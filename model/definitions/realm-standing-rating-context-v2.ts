import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmStandingRatingContextDeclaration = {
  id: 'realm-standing-rating-context-v2',
  canonical: {
    context: { types: ['rv:ScaledRatingContext'] },
  },
  binding: {
    required: ['realm', 'context', 'question'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:ScaledRatingContext'],
  },
} as const satisfies TurtleDeclaration;
