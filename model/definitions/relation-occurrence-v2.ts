import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** V2 is opt-in on every owned record; V1 remains the canonical default. */
export const attributedRelationDeclaration = {
  id: 'relation-occurrence-v2',
  canonical: {
    occurrence: { types: ['rv:RelationOccurrence'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/relation-occurrence-v2>' }] },
    participation: { types: ['rv:RelationParticipation'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/relation-occurrence-v2>' }] },
    revision: { types: ['rv:RelationOccurrenceRevision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/relation-occurrence-v2>' }] },
  },
} as const satisfies TurtleDeclaration;
