import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmTargetRatingContextV2Declaration = {
  id: 'realm-target-rating-context-v2',
  canonical: {
    context: {
      types: ['rv:LanguageTaggedTargetRatingContext'],
    },
  },
  binding: {
    required: ['realm', 'context', 'question', 'language', 'grain'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:LanguageTaggedTargetRatingContext'],
  },
} as const satisfies TurtleDeclaration;
