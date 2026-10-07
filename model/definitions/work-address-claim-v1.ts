import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workAddressClaimDeclaration = {
  id: 'work-address-claim-v1',
  canonical: {
    binding: {
      types: ['<https://rezics.com/vocab/RouteBinding>'],
    },
  },
} as const satisfies TurtleDeclaration;
