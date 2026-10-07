import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmExperienceRatingContextDeclaration = {
  id: 'realm-experience-rating-context-v1',
  canonical: {
    context: { types: ['rv:ExperienceRatingContext'] },
  },
  binding: {
    required: ['realm', 'context', 'question'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:ExperienceRatingContext'],
  },
} as const satisfies TurtleDeclaration;
