import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmExperienceRatingObservationDeclaration = {
  id: 'realm-experience-rating-observation-v1',
  canonical: {
    observation: { types: ['rv:ExperienceRatingObservation'] },
    revision: { types: ['rv:ExperienceRatingObservationRevision'] },
  },
  binding: {
    required: [
      'realm', 'context', 'work', 'main', 'slot', 'observation', 'revision', 'availability', 'occasion',
    ],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:ExperienceRatingObservation', 'rv:ExperienceRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
