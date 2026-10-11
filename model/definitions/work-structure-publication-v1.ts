import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workStructurePublicationDeclaration = {
  id: 'work-structure-publication-v1',
  canonical: {
    decision: { types: ['rv:WorkStructurePublicationDecision'] },
    source: { types: ['rv:WorkStructurePublicSource'] },
  },
} as const satisfies TurtleDeclaration;
