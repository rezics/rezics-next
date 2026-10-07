import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmDailyRatingContextDeclaration = {
  id: 'realm-daily-rating-context-v1',
  canonical: {
    context: { types: ['rv:DailyRatingContext'] },
  },
  binding: {
    required: ['realm', 'context', 'question', 'timeZone'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:DailyRatingContext'],
  },
} as const satisfies TurtleDeclaration;
