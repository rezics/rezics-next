import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const contentPublicationDeclaration = {
  id: 'content-publication-v1',
  canonical: {
    variant: { types: ['rv:ContentVariant'] },
    decision: { types: ['rv:ContentPublicationDecision'] },
  },
} as const satisfies TurtleDeclaration;
