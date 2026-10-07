import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const globalRatingStandingContextDeclaration = {
  id: 'global-rating-standing-context-v1',
  canonical: { context: { types: ['rv:GlobalRatingContext'] } },
  binding: {
    required: ['context', 'question'],
    roles: ['context'],
    demandedBy: ['rv:GlobalRatingContext'],
  },
} as const satisfies TurtleDeclaration;
