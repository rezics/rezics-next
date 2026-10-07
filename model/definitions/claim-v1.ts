import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** Equal proposition text never merges Claim identities; exact revisions retain their identity triple. */
export const claimDeclaration = {
  id: 'claim-v1',
  canonical: {
    claim: { types: ['rv:Claim'] },
    revision: { types: ['rv:ClaimRevision'] },
  },
} as const satisfies TurtleDeclaration;
