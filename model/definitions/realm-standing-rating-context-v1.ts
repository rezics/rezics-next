import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmStandingRatingContextDeclaration = {
  id: 'realm-standing-rating-context-v1',
  canonical: {
    context: { types: ['rv:RatingContext'] },
  },
  binding: {
    required: ['realm', 'context', 'question'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:RatingContext'],
  },
} as const satisfies TurtleDeclaration;
