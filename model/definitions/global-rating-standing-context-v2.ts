import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const globalRatingStandingContextDeclaration = {
  id: 'global-rating-standing-context-v2',
  canonical: { context: { types: ['rv:ScaledGlobalRatingContext'] } },
  binding: {
    required: ['context', 'question'],
    roles: ['context'],
    demandedBy: ['rv:ScaledGlobalRatingContext'],
  },
} as const satisfies TurtleDeclaration;
