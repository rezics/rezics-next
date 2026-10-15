import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const sourcedWorkStructurePublicationDeclaration = {
  id: 'work-structure-publication-v2',
  canonical: {
    decision: { types: ['rv:WorkStructurePublicationDecision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/work-structure-publication-v2>' }] },
    source: { types: ['rv:WorkStructurePublicSource'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/work-structure-publication-v2>' }] },
  },
} as const satisfies TurtleDeclaration;
