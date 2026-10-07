import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmDailyRatingObservationDeclaration = {
  id: 'realm-daily-rating-observation-v1',
  canonical: {
    observation: { types: ['rv:DailyRatingObservation'] },
    revision: { types: ['rv:DailyRatingObservationRevision'] },
  },
  binding: {
    required: [
      'realm', 'context', 'work', 'main', 'slot', 'observation', 'revision', 'availability',
      'day', 'timeZone', 'periodStart', 'periodEnd',
    ],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:DailyRatingObservation', 'rv:DailyRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
