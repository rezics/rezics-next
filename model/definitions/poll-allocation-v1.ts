import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const pollAllocationDeclaration = {
  id: 'poll-allocation-v1',
  canonical: {
    plan: { types: ['rv:AllocationPlan'] },
    leaf: { types: ['rv:AllocationLeaf'] },
    activation: { types: ['rv:AllocationActivation'] },
  },
} as const satisfies TurtleDeclaration;

export const pollAllocationProfile = parseTurtleProfile(
  pollAllocationDeclaration.id,
  readFileSync(new URL('./poll-allocation-v1.ttl', import.meta.url), 'utf8'),
  pollAllocationDeclaration,
);
