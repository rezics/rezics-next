import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmReleaseRatingObservationDeclaration = {
  id: 'realm-release-rating-observation-v1',
  canonical: {
    observation: { types: ['rv:ReleaseRatingObservation'] },
    revision: { types: ['rv:ReleaseRatingObservationRevision'] },
  },
  binding: {
    required: ['realm', 'context', 'work', 'main', 'release', 'slot', 'observation', 'revision',
      'availability'],
    optional: ['value', 'predecessor'],
    roles: ['realm', 'context', 'work', 'main', 'release', 'observation', 'revision'],
    demandedBy: ['rv:ReleaseRatingObservation', 'rv:ReleaseRatingObservationRevision'],
  },
} as const satisfies TurtleDeclaration;
