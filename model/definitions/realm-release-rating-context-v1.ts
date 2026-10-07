import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const realmReleaseRatingContextDeclaration = {
  id: 'realm-release-rating-context-v1',
  canonical: { context: { types: ['rv:ReleaseRatingContext'] } },
  binding: {
    required: ['realm', 'context', 'question'],
    roles: ['realm', 'context'],
    demandedBy: ['rv:ReleaseRatingContext'],
  },
} as const satisfies TurtleDeclaration;
